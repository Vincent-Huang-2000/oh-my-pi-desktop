/**
 * elicitationText — Elicitation 审批结果文本生成。
 *
 * getElicitationResultText(request, action, content) 将用户的审批操作
 * 转换为人类可读的结果文本，显示在对应消息气泡下方。
 * 按 request.kind 区分：
 * - question: 展示用户提交的选择内容
 * - tool: 展示接受/拒绝的工具名
 */
import type { ElicitationRequest } from '../types';

const getElicitationValueText = (value: unknown) => {
  if (value === undefined || value === '') return '';
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string').join('、');
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }
  return JSON.stringify(value);
};

/* 审批状态和用户回答分开保存；展示层不再从拼接后的文本推断或裁剪答案。 */
export type ElicitationResult = {
  label: string;
  answer?: string;
};

/* 兼容历史记录：旧消息仅有完整结果文本时，answer 缺失则原样显示 label。 */
export const formatElicitationResult = (label: string, answer?: string): string =>
  answer ? `${label}：${answer}` : label;

export const getElicitationResult = (
  request: ElicitationRequest,
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown>,
): ElicitationResult => {
  if (action === 'decline') return { label: '已拒绝' };
  if (action === 'cancel') return { label: '已取消' };
  const [legacyField] = request.fields;
  const value = content?.value;
  if (value === true) return { label: '已确认' };
  if (legacyField?.name === 'value' && legacyField.options?.length && typeof value === 'string') {
    if (value.endsWith(' Done selecting') || value === 'Done selecting') {
      return { label: '已完成选择' };
    }
    return { label: '已选择', answer: value.replace(/ \(Recommended\)$/, '') };
  }
  if (legacyField?.name === 'value' && value !== undefined) {
    return { label: '已提交', answer: getElicitationValueText(value) };
  }

  const responses = request.fields.flatMap((field, index) => {
    const selectedValue = content?.[field.name];
    const customValue = field.otherFieldName ? content?.[field.otherFieldName] : undefined;
    if (
      field.type === 'array' &&
      Array.isArray(selectedValue) &&
      selectedValue.length === 0 &&
      !getElicitationValueText(customValue)
    ) {
      return [`${field.title ?? `回答 ${index + 1}`}：未选择任何项`];
    }
    const rawValues =
      field.type === 'array' && field.otherFieldName
        ? [content?.[field.name], customValue]
        : [customValue ?? content?.[field.name]];
    const valueText = rawValues.map(getElicitationValueText).filter(Boolean).join('、');
    return valueText ? [`${field.title ?? `回答 ${index + 1}`}：${valueText}`] : [];
  });
  return responses.length > 0
    ? { label: '已提交', answer: responses.join('；') }
    : { label: '已提交' };
};

/* 保留原字符串接口，供只需要单行文本的调用方和既有测试使用。 */
export const getElicitationResultText = (
  request: ElicitationRequest,
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown>,
): string => {
  const result = getElicitationResult(request, action, content);
  return formatElicitationResult(result.label, result.answer);
};
