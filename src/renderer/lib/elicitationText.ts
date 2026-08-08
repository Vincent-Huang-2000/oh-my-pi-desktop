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

export const getElicitationResultText = (
  request: ElicitationRequest,
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown>,
) => {
  if (action === 'decline') return '已拒绝';
  if (action === 'cancel') return '已取消';
  const value = content?.value;
  if (value === true) return '已确认';
  if (request.field.options?.length && typeof value === 'string') {
    if (value.endsWith(' Done selecting') || value === 'Done selecting') return '已完成选择';
    return `已选择：${value.replace(/ \(Recommended\)$/, '')}`;
  }
  if (value !== undefined) {
    if (typeof value === 'string') return `已提交：${value}`;
    if (typeof value === 'number' || typeof value === 'boolean') return `已提交：${String(value)}`;
    return `已提交：${JSON.stringify(value)}`;
  }
  return '已提交';
};
