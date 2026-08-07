/**
 * historyLoaders — 历史回放与活跃方案管理。
 *
 * 处理 session/load 重放数据与活跃 plan 的提取/注入：
 * - getHistoryLoadedEvents/Plans：从重放响应中分离普通事件和 plan 事件
 * - insertHistoricalPlans：将历史 plan 插入 ToolCallBucket 供 UI 展示
 * - getActiveSessionPlan / applyActiveSessionPlan：当前 session 的活跃方案管理
 *
 * ## 维护
 * - HistoricalSessionPlan 的 planFilePath 是相对于项目根目录的路径。
 * - 回放时 plan 事件的处理顺序需与首次产生时的顺序一致。
 */
import type { ChatMessage } from '../types';

export type HistoricalSessionPlan = {
  id: string;
  toolCallId: string;
  planFilePath: string;
  content: string;
};

export type ActiveSessionPlan =
  | { active: false }
  | { active: true; planFilePath: string; content: string | null };

export const getHistoryLoadedEvents = (payload: unknown): AgentEvent[] => {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const events = (payload as { events?: unknown }).events;
  return Array.isArray(events) ? (events as AgentEvent[]) : [];
};

export const getHistoryLoadedPlans = (payload: unknown): HistoricalSessionPlan[] => {
  if (!payload || typeof payload !== 'object') return [];
  const plans = (payload as { plans?: unknown }).plans;
  if (!Array.isArray(plans)) return [];
  return plans.filter((plan): plan is HistoricalSessionPlan => (
    typeof plan === 'object' &&
    plan !== null &&
    typeof plan.id === 'string' &&
    typeof plan.toolCallId === 'string' &&
    typeof plan.planFilePath === 'string' &&
    typeof plan.content === 'string'
  ));
};

export const insertHistoricalPlans = (
  messages: ChatMessage[],
  plans: HistoricalSessionPlan[]
) => {
  const next = [...messages];
  for (const plan of plans) {
    if (next.some((message) => message.id === plan.id)) continue;
    const planMessage: ChatMessage = {
      id: plan.id,
      role: 'plan',
      text: plan.content,
      planId: plan.id,
      planContentType: 'markdown',
      planFilePath: plan.planFilePath
    };
    const toolIndex = next.findIndex((message) => message.toolCallId === plan.toolCallId);
    if (toolIndex >= 0) {
      next.splice(toolIndex + 1, 0, planMessage);
    } else {
      next.push(planMessage);
    }
  }
  return next;
};

export const getActiveSessionPlan = (payload: unknown): ActiveSessionPlan | null => {
  if (!payload || typeof payload !== 'object') return null;
  const plan = payload as Record<string, unknown>;
  if (plan.active === false) return { active: false };
  if (
    plan.active !== true ||
    typeof plan.planFilePath !== 'string' ||
    (typeof plan.content !== 'string' && plan.content !== null)
  ) {
    return null;
  }
  return {
    active: true,
    planFilePath: plan.planFilePath,
    content: plan.content
  };
};

export const applyActiveSessionPlan = (messages: ChatMessage[], plan: ActiveSessionPlan) => {
  const withoutPreviousActive = messages.filter((message) => !message.planActive);
  if (!plan.active) return withoutPreviousActive;
  const withoutDuplicate = withoutPreviousActive.filter(
    (message) => !message.planPending && message.planFilePath !== plan.planFilePath
  );
  return [
    ...withoutDuplicate,
    {
      id: 'active-session-plan',
      role: 'plan' as const,
      text: plan.content ?? `方案文件：${plan.planFilePath}\n\n暂时无法读取方案正文。`,
      planId: 'active-session-plan',
      planContentType: 'markdown' as const,
      planActive: true,
      planFilePath: plan.planFilePath,
      // 活跃方案来自 session `_meta`，故意不设置 planPreviewRequestId。
    }
  ];
};
