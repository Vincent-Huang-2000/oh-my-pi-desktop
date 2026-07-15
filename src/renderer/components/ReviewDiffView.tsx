import { useEffect, useMemo, useState } from 'react';
import { parseUnifiedDiff, type ParsedDiffFile, type ParsedDiffLine } from '../diffParser';

type ReviewDiffViewProps = {
  diffText: string;
  diffStatus: string;
};

const FILE_STATUS_LABEL: Record<ParsedDiffFile['status'], string> = {
  modified: '已修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  binary: '二进制',
};

const getLinePrefix = (line: ParsedDiffLine) => {
  if (line.kind === 'added') {
    return '+';
  }
  if (line.kind === 'removed') {
    return '-';
  }
  return '';
};

const renderLineNumber = (lineNumber: number | null) => (lineNumber === null ? '' : lineNumber);

const getDiffFileKey = (file: ParsedDiffFile, index: number) => `${file.oldPath}->${file.newPath}-${index}`;

/** 渲染单行 diff，包含固定行号区、增删前缀和代码内容。 */
function DiffLine({ line }: { line: ParsedDiffLine }) {
  if (line.kind === 'hunk') {
    return (
      <div className="review-diff-line review-diff-line-hunk">
        <span className="review-diff-gutter" />
        <span className="review-diff-code-text">{line.content}</span>
      </div>
    );
  }

  if (line.kind === 'meta') {
    return (
      <div className="review-diff-line review-diff-line-meta">
        <span className="review-diff-gutter" />
        <span className="review-diff-code-text">{line.content}</span>
      </div>
    );
  }

  return (
    <div className={`review-diff-line review-diff-line-${line.kind}`}>
      <span className="review-diff-gutter review-diff-old-line">{renderLineNumber(line.oldLineNumber)}</span>
      <span className="review-diff-gutter review-diff-new-line">{renderLineNumber(line.newLineNumber)}</span>
      <span className="review-diff-prefix">{getLinePrefix(line)}</span>
      <span className="review-diff-code-text">{line.content || ' '}</span>
    </div>
  );
}

/** 渲染单个文件的 diff 卡片，负责文件展开、hunk 导航和代码块内容。 */
function DiffFileBlock({
  file,
  fileIndex,
  fileKey,
  open,
  onToggle,
}: {
  file: ParsedDiffFile;
  fileIndex: number;
  fileKey: string;
  open: boolean;
  onToggle: (fileKey: string) => void;
}) {
  const hasBody = file.hunks.length > 0 || file.metaLines.length > 0;
  const bodyId = `review-diff-file-${fileIndex}`;
  const hunkIds = file.hunks.map((_, hunkIndex) => `review-diff-file-${fileIndex}-hunk-${hunkIndex}`);

  /** 在大文件内部快速跳转到指定 hunk。 */
  const handleJumpToHunk = (hunkId: string) => {
    // 保持用户仍在当前文件内，只把代码块滚动到对应变更片段。
    document.getElementById(hunkId)?.scrollIntoView({ block: 'start' });
  };

  return (
    <div className={open ? 'review-diff-file open' : 'review-diff-file'}>
      <button
        type="button"
        className="review-diff-file-header"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onToggle(fileKey)}
      >
        <span className={`review-diff-file-status review-diff-file-status-${file.status}`}>
          {FILE_STATUS_LABEL[file.status]}
        </span>
        <span className="review-diff-file-path" title={file.displayPath}>{file.displayPath}</span>
        <span className="review-diff-file-stat review-diff-file-additions">+{file.additions}</span>
        <span className="review-diff-file-stat review-diff-file-deletions">-{file.deletions}</span>
      </button>
      {open && (
        hasBody ? (
          <div className="review-diff-file-body" id={bodyId}>
            {file.hunks.length > 1 && (
              <div className="review-diff-hunk-nav" aria-label={`${file.displayPath} 变更片段导航`}>
                <span className="review-diff-hunk-nav-label">片段</span>
                {file.hunks.map((hunk, hunkIndex) => (
                  <button
                    type="button"
                    className="review-diff-hunk-button"
                    title={hunk.header}
                    key={`${hunk.header}-${hunkIndex}`}
                    onClick={() => handleJumpToHunk(hunkIds[hunkIndex])}
                  >
                    {hunkIndex + 1}
                  </button>
                ))}
              </div>
            )}
            <div className="review-diff-code">
              {file.metaLines.map((line, index) => (
                <div className="review-diff-line review-diff-line-meta" key={`meta-${index}`}>
                  <span className="review-diff-gutter" />
                  <span className="review-diff-code-text">{line}</span>
                </div>
              ))}
              {file.hunks.map((hunk, hunkIndex) => (
                <div className="review-diff-hunk" id={hunkIds[hunkIndex]} key={`${hunk.header}-${hunkIndex}`}>
                  {hunk.lines.map((line, lineIndex) => (
                    <DiffLine line={line} key={`${line.kind}-${line.oldLineNumber ?? ''}-${line.newLineNumber ?? ''}-${lineIndex}`} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="review-diff-binary-note" id={bodyId}>此文件没有可展示的文本改动。</div>
        )
      )}
    </div>
  );
}

/** 将原始 git diff 渲染成右侧审查 Tab 的 VS Code 风格单栏 diff。 */
export function ReviewDiffView({ diffText, diffStatus }: ReviewDiffViewProps) {
  const files = useMemo(() => parseUnifiedDiff(diffText), [diffText]);
  const fileKeys = useMemo(() => files.map(getDiffFileKey), [files]);
  const [listOnly, setListOnly] = useState(true);
  const [openFileKeys, setOpenFileKeys] = useState<Set<string>>(() => new Set());
  const additions = files.reduce((count, file) => count + file.additions, 0);
  const deletions = files.reduce((count, file) => count + file.deletions, 0);

  useEffect(() => {
    // 默认保持文件总览，避免大 diff 一打开就被大量代码淹没。
    setListOnly(true);
    setOpenFileKeys(new Set());
  }, [diffText]);

  /** 切回只看文件名、状态和增删统计的总览模式。 */
  const handleShowFileList = () => {
    setListOnly(true);
    setOpenFileKeys(new Set());
  };

  /** 一次性展开全部文件，适合需要连续审查完整 diff 的场景。 */
  const handleExpandAll = () => {
    setListOnly(false);
    setOpenFileKeys(new Set(fileKeys));
  };

  /** 一次性收起全部文件，但保留批量控制栏的当前模式状态。 */
  const handleCollapseAll = () => {
    setListOnly(false);
    setOpenFileKeys(new Set());
  };

  /** 切换单个文件展开状态；从总览模式点击文件时直接进入细看模式。 */
  const handleToggleFile = (fileKey: string) => {
    setListOnly(false);
    setOpenFileKeys((current) => {
      const next = new Set(current);
      if (listOnly || !next.has(fileKey)) {
        next.add(fileKey);
      } else {
        next.delete(fileKey);
      }
      return next;
    });
  };

  if (files.length === 0) {
    return (
      <div className="review-diff-view">
        <p className="review-status">{diffStatus}</p>
        <pre className="review-diff-box">{diffText}</pre>
      </div>
    );
  }

  return (
    <div className="review-diff-view">
      <div className="review-diff-summary">
        <div className="review-diff-summary-meta">
          <span>{diffStatus}</span>
          <strong>{files.length} 个文件</strong>
          <span className="review-diff-file-additions">+{additions}</span>
          <span className="review-diff-file-deletions">-{deletions}</span>
        </div>
        <div className="review-diff-actions" aria-label="Diff 展示控制">
          <button
            type="button"
            className={listOnly ? 'review-diff-action active' : 'review-diff-action'}
            aria-pressed={listOnly}
            onClick={handleShowFileList}
          >
            只看文件列表
          </button>
          <button
            type="button"
            className={!listOnly && openFileKeys.size === files.length ? 'review-diff-action active' : 'review-diff-action'}
            aria-pressed={!listOnly && openFileKeys.size === files.length}
            onClick={handleExpandAll}
          >
            展开全部
          </button>
          <button
            type="button"
            className={!listOnly && openFileKeys.size === 0 ? 'review-diff-action active' : 'review-diff-action'}
            aria-pressed={!listOnly && openFileKeys.size === 0}
            onClick={handleCollapseAll}
          >
            收起全部
          </button>
        </div>
      </div>
      <div className="review-diff-files">
        {files.map((file, index) => {
          const fileKey = fileKeys[index];
          return (
            <DiffFileBlock
              file={file}
              fileIndex={index}
              fileKey={fileKey}
              open={!listOnly && openFileKeys.has(fileKey)}
              onToggle={handleToggleFile}
              key={fileKey}
            />
          );
        })}
      </div>
    </div>
  );
}
