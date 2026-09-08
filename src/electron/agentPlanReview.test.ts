import { describe, expect, it } from 'vitest';
import {
  isPlanReviewForm,
  parsePlanReview,
  validatePlanReviewSubmission,
} from './agentPlanReview.js';
const review = {
  reviewId: 'r1',
  planFilePath: 'local://a-plan.md',
  title: 'A',
  content: '# A',
  feedback: '',
  options: ['execute', 'compact', 'keep', 'refine', 'save'].map((id) => ({ id })),
};
describe('计划审核契约边界', () => {
  it('保留完整正文且拒绝未知、重复选项和无效用量', () => {
    expect(parsePlanReview(review)?.content).toBe('# A');
    expect(parsePlanReview({ ...review, options: [{ id: 'unknown' }] })).toBeNull();
    expect(parsePlanReview({ ...review, options: [{ id: 'keep' }, { id: 'keep' }] })).toBeNull();
    expect(
      parsePlanReview({ ...review, context: { tokens: Infinity, contextWindow: 100 } }),
    ).toBeNull();
  });
  it('禁用选项、无效模型和空保存路径不能绕过界面', () => {
    const parsed = parsePlanReview({
      ...review,
      options: [{ id: 'keep', disabled: true }, { id: 'save' }],
    })!;
    expect(validatePlanReviewSubmission(parsed, { decision: 'keep' })).toBe(false);
    expect(validatePlanReviewSubmission(parsed, { decision: 'save', savePath: ' ' })).toBe(false);
    expect(
      validatePlanReviewSubmission(parsed, {
        decision: 'save',
        savePath: 'a.md',
        executionModel: 'made-up',
      }),
    ).toBe(false);
    expect(
      validatePlanReviewSubmission(parsed, {
        decision: 'save',
        savePath: 'a.md',
        editedContent: '# Edited',
      }),
    ).toBe(true);
  });
  it('普通表单不被识别为方案审核', () => {
    expect(isPlanReviewForm({ properties: { decision: { oneOf: [{ const: 'approve' }] } } })).toBe(
      false,
    );
    expect(
      isPlanReviewForm({
        properties: { decision: { oneOf: review.options.map((option) => ({ const: option.id })) } },
      }),
    ).toBe(true);
  });
});
