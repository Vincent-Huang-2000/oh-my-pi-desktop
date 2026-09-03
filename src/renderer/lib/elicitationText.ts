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

export const getElicitationResultText = (
  request: ElicitationRequest,
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown>,
) => {
  if (action === 'decline') return '已拒绝';
  if (action === 'cancel') return '已取消';
  const [legacyField] = request.fields;
  const value = content?.value;
  if (value === true) return '已确认';
  if (legacyField?.name === 'value' && legacyField.options?.length && typeof value === 'string') {
    if (value.endsWith(' Done selecting') || value === 'Done selecting') return '已完成选择';
    return `已选择：${value.replace(/ \(Recommended\)$/, '')}`;
  }
  if (legacyField?.name === 'value' && value !== undefined) {
    if (typeof value === 'string') return `已提交：${value}`;
    if (typeof value === 'number' || typeof value === 'boolean') return `已提交：${String(value)}`;
    return `已提交：${JSON.stringify(value)}`;
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
  return responses.length > 0 ? `已提交：${responses.join('；')}` : '已提交';
};
