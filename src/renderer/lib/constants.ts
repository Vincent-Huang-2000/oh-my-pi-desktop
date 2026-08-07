// 附件大小上限（图片 / 文本 / 其它统一 8MB）。dataURL 是 base64，长度约为原文件 ×4/3。
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const LEFT_PANE_DEFAULT_WIDTH = 280;
export const LEFT_PANE_MIN_WIDTH = 120;
export const LEFT_PANE_MAX_WIDTH = 480;
export const LEFT_PANE_COLLAPSE_THRESHOLD = 180;

export const RIGHT_PANE_DEFAULT_WIDTH = 320;
export const RIGHT_PANE_MIN_WIDTH = 180;
export const RIGHT_PANE_MAX_WIDTH = 560;
export const RIGHT_PANE_COLLAPSE_THRESHOLD = 220;

export type PaneSide = 'left' | 'right';
export type ReviewSource = 'unstaged' | 'staged';
export type DraftConfigValues = Partial<Record<'model' | 'mode' | 'thinking', string>>;

export const DEFAULT_APPROVAL_PROFILE: ApprovalProfile = 'write';

export const REVIEW_SOURCE_LABEL: Record<ReviewSource, string> = {
  unstaged: '未暂存',
  staged: '已暂存',
};
