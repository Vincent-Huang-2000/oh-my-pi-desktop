import type { ElicitationRequest } from '../types';

export const getElicitationResultText = (
  request: ElicitationRequest,
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown>
) => {
  if (action === 'decline') return '已拒绝';
  if (action === 'cancel') return '已取消';
  const value = content?.value;
  if (value === true) return '已确认';
  if (request.field.options?.length && typeof value === 'string') {
    if (value.endsWith(' Done selecting') || value === 'Done selecting') return '已完成选择';
    return `已选择：${value.replace(/ \(Recommended\)$/, '')}`;
  }
  if (value !== undefined) return `已提交：${String(value)}`;
  return '已提交';
};
