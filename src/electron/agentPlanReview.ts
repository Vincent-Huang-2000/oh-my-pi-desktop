import { isRecord } from './agentUtils.js';
import type { PlanReviewData, PlanReviewDecision, PlanReviewSubmission } from './types.js';

const decisions: PlanReviewDecision[] = ['execute', 'compact', 'keep', 'refine', 'save'];
export function parsePlanReview(value: unknown): PlanReviewData | null {
  if (
    !isRecord(value) ||
    typeof value.reviewId !== 'string' ||
    !value.reviewId ||
    typeof value.planFilePath !== 'string' ||
    !value.planFilePath ||
    typeof value.title !== 'string' ||
    (typeof value.content !== 'string' && value.content !== null) ||
    typeof value.feedback !== 'string' ||
    !Array.isArray(value.options) ||
    !value.options.length
  )
    return null;
  const options: PlanReviewData['options'] = [];
  for (const item of value.options) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !decisions.includes(item.id as PlanReviewDecision) ||
      (item.disabled !== undefined && typeof item.disabled !== 'boolean') ||
      options.some((option) => option.id === item.id)
    )
      return null;
    options.push({
      id: item.id as PlanReviewData['options'][number]['id'],
      disabled: item.disabled === true,
    });
  }
  const executionModels: NonNullable<PlanReviewData['executionModels']> = [];
  if (value.executionModels !== undefined) {
    if (!Array.isArray(value.executionModels)) return null;
    for (const item of value.executionModels) {
      if (
        !isRecord(item) ||
        typeof item.id !== 'string' ||
        !item.id ||
        typeof item.label !== 'string' ||
        executionModels.some((model) => model.id === item.id)
      )
        return null;
      executionModels.push({ id: item.id, label: item.label, default: item.default === true });
    }
  }
  const context = value.context;
  if (
    context !== undefined &&
    (!isRecord(context) ||
      typeof context.tokens !== 'number' ||
      !Number.isFinite(context.tokens) ||
      context.tokens < 0 ||
      typeof context.contextWindow !== 'number' ||
      !Number.isFinite(context.contextWindow) ||
      context.contextWindow <= 0)
  )
    return null;
  return {
    reviewId: value.reviewId,
    planFilePath: value.planFilePath,
    title: value.title,
    content: value.content,
    feedback: value.feedback,
    options,
    executionModels,
    ...(isRecord(context)
      ? {
          context: {
            tokens: context.tokens as number,
            contextWindow: context.contextWindow as number,
          },
        }
      : {}),
  };
}

// 新审核通知与紧随其后的五选项表单配对；普通审批不能接管计划审核。
export function isPlanReviewForm(schema: unknown): boolean {
  if (!isRecord(schema) || !isRecord(schema.properties) || !isRecord(schema.properties.decision))
    return false;
  const choices = schema.properties.decision.oneOf;
  return (
    Array.isArray(choices) &&
    ['execute', 'compact', 'refine', 'save'].every((id) =>
      choices.some((choice) => isRecord(choice) && choice.const === id),
    )
  );
}

export function validatePlanReviewSubmission(
  review: PlanReviewData,
  value: unknown,
): value is PlanReviewSubmission {
  if (!isRecord(value) || typeof value.decision !== 'string') return false;
  if (value.decision === 'cancel') return true;
  if (
    review.content === null ||
    !review.options.some((option) => option.id === value.decision && !option.disabled)
  )
    return false;
  for (const key of ['feedback', 'editedContent', 'executionModel', 'savePath']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  if (value.decision === 'save' && (typeof value.savePath !== 'string' || !value.savePath.trim()))
    return false;
  if (
    value.executionModel !== undefined &&
    !review.executionModels?.some((model) => model.id === value.executionModel)
  )
    return false;
  return true;
}
