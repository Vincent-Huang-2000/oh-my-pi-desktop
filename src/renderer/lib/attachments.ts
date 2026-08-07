// 待发送的附件。kind 决定发送时走哪种 ACP 块（见主进程 buildPromptBlocks）：
//  - image:       omp 能让模型看到（base64 图片）
//  - text:        base64 解码后追加到 text 块，omp 能让模型看到
//  - unsupported: 仍发送，但 omp 会兜底成占位符，模型读不到内容（chip 上标警告）
export type PendingAttachment = {
  dataUrl: string;
  fileName: string;
  kind: 'image' | 'text' | 'unsupported';
};

// 文本类附件扩展名清单：命中则按 text 处理（解码后拼进 text 块）。
// 未命中且非 image/* 的，按 unsupported 处理。
const TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.json', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.csv', '.log', '.yml', '.yaml', '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.ini', '.conf', '.sh', '.bash', '.bat', '.ps1', '.rs', '.go', '.java', '.c', '.cpp', '.cc',
  '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.sql', '.graphql', '.vue', '.svelte'
];

// 按 MIME + 文件名扩展名判定附件类别。
export const classifyAttachment = (file: File): 'image' | 'text' | 'unsupported' => {
  if (file.type.startsWith('image/')) {
    return 'image';
  }
  if (file.type.startsWith('text/')) {
    return 'text';
  }
  const lower = file.name.toLowerCase();
  if (TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return 'text';
  }
  return 'unsupported';
};
