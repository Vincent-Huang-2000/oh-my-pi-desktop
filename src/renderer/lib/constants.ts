/**
 * constants — 布局常量、共享类型与默认值。
 *
 * - 侧栏尺寸常量：LEFT_PANE_* / RIGHT_PANE_*
 * - 共享类型：PaneSide、ReviewSource、DraftConfigValues
 * - 默认值：DEFAULT_APPROVAL_PROFILE、MAX_IMAGE_BYTES、REVIEW_SOURCE_LABEL
 *
 * ## 维护
 * - 修改 DEFAULT_APPROVAL_PROFILE 需同步检查 useConfigSync 中 handleApprovalProfileChange 逻辑。
 * - DraftConfigValues 的字段名需与 ACP config options 的 option.id 一致。
 */
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
