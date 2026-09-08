import { describe, expect, it } from 'vitest';
import {
  compilePlanFeedback,
  deletePlanSection,
  getPlanSections,
  type PlanReviewDraft,
} from './planReview';
describe('审核编辑与批注', () => {
  it('目录忽略代码标题，删除父章节包含子章节且可以恢复原文', () => {
    const content = '# A\nintro\n## A1\n```md\n# fake\n```\n# B\nkeep';
    const sections = getPlanSections(content);
    expect(sections.map((s) => s.title)).toEqual(['A', 'A1', 'B']);
    const draft: PlanReviewDraft = {
      reviewId: 'r1',
      content,
      feedback: '',
      model: '',
      notes: [],
      deleted: [],
      undo: [],
    };
    const edited = deletePlanSection(draft, sections[0]);
    expect(edited.content).toBe('# B\nkeep');
    expect(edited.undo[0]).toEqual({ content, deleted: [] });
    expect(compilePlanFeedback(edited)).toContain('A');
  });
  it('反馈同时包含整体意见、定位原文和删除记录', () => {
    expect(
      compilePlanFeedback({
        reviewId: 'r1',
        content: '',
        model: '',
        undo: [],
        feedback: '补充验证',
        deleted: ['旧功能'],
        notes: [{ anchor: '第 3 行：部署', text: '先确认环境' }],
      }),
    ).toBe('补充验证\n\n请删除以下章节：\n- 旧功能\n\n位置：第 3 行：部署\n意见：先确认环境');
  });
});
