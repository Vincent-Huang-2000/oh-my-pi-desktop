export type PlanSection = { title: string; start: number; end: number; level: number };
export type PlanReviewDraft = {
  pendingNote?: string;
  anchor?: string;
  reviewId: string;
  content: string;
  feedback: string;
  model: string;
  notes: Array<{ anchor: string; text: string }>;
  deleted: string[];
  undo: Array<{ content: string; deleted: string[] }>;
};
// 围栏代码中的 # 不作为章节；隐藏章节同时包括其子章节。
export function getPlanSections(content: string): PlanSection[] {
  const lines = content.split('\n');
  const headings: Array<{ title: string; start: number; level: number }> = [];
  let fence = '';
  lines.forEach((line, start) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      return;
    }
    if (fence) return;
    const match = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (match) headings.push({ title: match[2], start, level: match[1].length });
  });
  return headings.map((heading, index) => ({
    ...heading,
    end:
      headings.slice(index + 1).find((next) => next.level <= heading.level)?.start ?? lines.length,
  }));
}
/**
 * 切换章节隐藏状态：正文保持不变，只把章节标题记入/移出 deleted；
 * 同名章节会一起隐藏/恢复。undo 仍快照 content + deleted，撤销行为不变。
 */
export function togglePlanSectionHidden(
  draft: PlanReviewDraft,
  section: PlanSection,
): PlanReviewDraft {
  const hidden = draft.deleted.includes(section.title);
  return {
    ...draft,
    deleted: hidden
      ? draft.deleted.filter((title) => title !== section.title)
      : [...draft.deleted, section.title],
    undo: [...draft.undo.slice(-19), { content: draft.content, deleted: draft.deleted }],
  };
}
export type HiddenLineRange = { start: number; end: number };
/** 计算被隐藏章节（含子章节）的正文行区间，按起点排序并合并重叠区间。 */
export function getHiddenLineRanges(content: string, deleted: string[]): HiddenLineRange[] {
  if (deleted.length === 0) return [];
  const merged: HiddenLineRange[] = [];
  const ranges = getPlanSections(content)
    .filter((section) => deleted.includes(section.title))
    .map((section) => ({ start: section.start, end: section.end }))
    .sort((a, b) => a.start - b.start);
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start < last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
/** 生成提交用的有效正文：剔除隐藏区间的行；无隐藏时原样返回（引用不变）。 */
export function stripHiddenSections(content: string, deleted: string[]): string {
  const ranges = getHiddenLineRanges(content, deleted);
  if (ranges.length === 0) return content;
  return content
    .split('\n')
    .filter((_, index) => !ranges.some((range) => index >= range.start && index < range.end))
    .join('\n');
}
/**
 * 阅读模式剔除隐藏行后，原文 0 基行号 → 渲染后行号的映射；
 * 落入隐藏区间的行对齐到区间起点（即其后第一行可见内容的位置）。
 */
export function toVisibleLineStart(start: number, ranges: HiddenLineRange[]): number {
  let adjusted = start;
  for (const range of ranges) {
    if (range.start >= start) break;
    adjusted -= Math.min(range.end, start) - range.start;
  }
  return adjusted;
}
export function compilePlanFeedback(draft: PlanReviewDraft): string {
  return [
    draft.feedback.trim(),
    draft.deleted.length
      ? `请删除以下章节：\n${draft.deleted.map((title) => `- ${title}`).join('\n')}`
      : '',
    ...draft.notes.map((note) => `位置：${note.anchor}\n意见：${note.text}`),
  ]
    .filter(Boolean)
    .join('\n\n');
}
