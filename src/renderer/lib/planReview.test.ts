import { describe, expect, it } from 'vitest';
import {
  compilePlanFeedback,
  getHiddenLineRanges,
  getPlanSections,
  stripHiddenSections,
  toVisibleLineStart,
  togglePlanSectionHidden,
  type PlanReviewDraft,
} from './planReview';
describe('审核编辑与批注', () => {
  it('目录忽略代码标题，隐藏父章节包含子章节且正文保持完整', () => {
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
    // 隐藏只登记标题，正文不动；再次切换即恢复，undo 快照不变。
    const hidden = togglePlanSectionHidden(draft, sections[0]);
    expect(hidden.content).toBe(content);
    expect(hidden.deleted).toEqual(['A']);
    expect(hidden.undo[0]).toEqual({ content, deleted: [] });
    expect(togglePlanSectionHidden(hidden, sections[0]).deleted).toEqual([]);
    // 提交用的有效正文才剔除隐藏章节及其子章节。
    expect(stripHiddenSections(hidden.content, hidden.deleted)).toBe('# B\nkeep');
    expect(compilePlanFeedback(hidden)).toContain('A');
  });
  it('隐藏区间合并重叠且行号映射保持目录定位准确', () => {
    const content = '# A\na\n# B\nb\n## B1\nc\n# C\nd';
    // B 与 B1 的区间重叠（B1 是 B 的子章节），合并为 [2, 6)。
    const ranges = getHiddenLineRanges(content, ['B', 'B1']);
    expect(ranges).toEqual([{ start: 2, end: 6 }]);
    expect(toVisibleLineStart(0, ranges)).toBe(0);
    expect(toVisibleLineStart(6, ranges)).toBe(2);
    // 无隐藏时 strip 原样返回，避免无意义的新字符串。
    expect(stripHiddenSections(content, [])).toBe(content);
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
