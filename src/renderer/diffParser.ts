export type DiffLineKind = 'context' | 'added' | 'removed' | 'hunk' | 'meta';

export type ParsedDiffLine = {
  kind: DiffLineKind;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
};

export type ParsedDiffHunk = {
  header: string;
  lines: ParsedDiffLine[];
};

export type ParsedDiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';

export type ParsedDiffFile = {
  oldPath: string;
  newPath: string;
  displayPath: string;
  status: ParsedDiffFileStatus;
  additions: number;
  deletions: number;
  hunks: ParsedDiffHunk[];
  metaLines: string[];
};

const EMPTY_PATH = '/dev/null';

/** 去掉 git diff 路径中的 a/b 前缀和外层引号，保留 /dev/null 语义。 */
const stripGitPathPrefix = (value: string) => {
  const unquoted = value.replace(/^"|"$/g, '');
  if (unquoted === EMPTY_PATH) {
    return EMPTY_PATH;
  }
  return unquoted.replace(/^[ab]\//, '');
};

/** 创建单个文件的 diff 解析结果初始结构。 */
const createFile = (oldPath: string, newPath: string): ParsedDiffFile => ({
  oldPath,
  newPath,
  displayPath: newPath !== EMPTY_PATH ? newPath : oldPath,
  status: 'modified',
  additions: 0,
  deletions: 0,
  hunks: [],
  metaLines: [],
});

/** 根据路径和显式状态修正文件状态，保证新增、删除、重命名、二进制展示准确。 */
const getStatus = (file: ParsedDiffFile): ParsedDiffFileStatus => {
  if (file.status === 'binary' || file.status === 'renamed') {
    return file.status;
  }
  if (file.oldPath === EMPTY_PATH) {
    return 'added';
  }
  if (file.newPath === EMPTY_PATH) {
    return 'deleted';
  }
  return 'modified';
};

/** 将 git unified diff 文本解析成右侧审查面板可逐文件、逐 hunk 渲染的数据结构。 */
export const parseUnifiedDiff = (diffText: string): ParsedDiffFile[] => {
  const files: ParsedDiffFile[] = [];
  const lines = diffText.replace(/\r\n/g, '\n').split('\n');
  let currentFile: ParsedDiffFile | null = null;
  let currentHunk: ParsedDiffHunk | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  /** 记录文件级元信息，例如 new file mode、rename、binary 等非代码行。 */
  const pushMetaLine = (line: string) => {
    if (currentFile && line.trim()) {
      currentFile.metaLines.push(line);
    }
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git (.+) (.+)$/.exec(line);
      currentFile = createFile(
        stripGitPathPrefix(match?.[1] ?? ''),
        stripGitPathPrefix(match?.[2] ?? ''),
      );
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith('new file mode')) {
      currentFile.status = 'added';
      pushMetaLine(line);
      continue;
    }

    if (line.startsWith('deleted file mode')) {
      currentFile.status = 'deleted';
      pushMetaLine(line);
      continue;
    }

    if (line.startsWith('rename from ')) {
      currentFile.status = 'renamed';
      currentFile.oldPath = line.replace('rename from ', '');
      pushMetaLine(line);
      continue;
    }

    if (line.startsWith('rename to ')) {
      currentFile.status = 'renamed';
      currentFile.newPath = line.replace('rename to ', '');
      currentFile.displayPath = currentFile.newPath;
      pushMetaLine(line);
      continue;
    }

    if (line.startsWith('Binary files ')) {
      currentFile.status = 'binary';
      pushMetaLine(line);
      continue;
    }

    if (line.startsWith('--- ')) {
      currentFile.oldPath = stripGitPathPrefix(line.slice(4).trim());
      continue;
    }

    if (line.startsWith('+++ ')) {
      currentFile.newPath = stripGitPathPrefix(line.slice(4).trim());
      currentFile.displayPath = currentFile.newPath !== EMPTY_PATH ? currentFile.newPath : currentFile.oldPath;
      currentFile.status = getStatus(currentFile);
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunkMatch) {
      oldLineNumber = Number(hunkMatch[1]);
      newLineNumber = Number(hunkMatch[2]);
      currentHunk = {
        header: line,
        lines: [
          {
            kind: 'hunk',
            oldLineNumber: null,
            newLineNumber: null,
            content: line,
          },
        ],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      pushMetaLine(line);
      continue;
    }

    if (line.startsWith('+')) {
      currentHunk.lines.push({
        kind: 'added',
        oldLineNumber: null,
        newLineNumber,
        content: line.slice(1),
      });
      currentFile.additions += 1;
      newLineNumber += 1;
      continue;
    }

    if (line.startsWith('-')) {
      currentHunk.lines.push({
        kind: 'removed',
        oldLineNumber,
        newLineNumber: null,
        content: line.slice(1),
      });
      currentFile.deletions += 1;
      oldLineNumber += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      currentHunk.lines.push({
        kind: 'context',
        oldLineNumber,
        newLineNumber,
        content: line.slice(1),
      });
      oldLineNumber += 1;
      newLineNumber += 1;
      continue;
    }

    currentHunk.lines.push({
      kind: 'meta',
      oldLineNumber: null,
      newLineNumber: null,
      content: line,
    });
  }

  return files.map((file) => ({
    ...file,
    status: getStatus(file),
  }));
};
