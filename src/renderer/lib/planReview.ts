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
// 围栏代码中的 # 不作为章节；删除章节同时包括其子章节。
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
export function deletePlanSection(draft: PlanReviewDraft, section: PlanSection): PlanReviewDraft {
  const lines = draft.content.split('\n');
  return {
    ...draft,
    content: [...lines.slice(0, section.start), ...lines.slice(section.end)].join('\n'),
    deleted: [...draft.deleted, section.title],
    undo: [...draft.undo.slice(-19), { content: draft.content, deleted: draft.deleted }],
  };
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
