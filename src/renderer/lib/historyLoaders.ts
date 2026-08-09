/**
 * historyLoaders — 历史会话回放与活跃方案管理。
 *
 * 四个导出函数，处理 session/load 重放数据与当前活跃 plan 的提取/注入：
 * - getHistoryLoadedEvents：从重放 payload 中分离 agent 事件数组
 * - getHistoryLoadedPlans：从重放 payload 中分离方案文档列表
 * - insertHistoricalPlans：将历史方案文档作为 ChatMessage 插入消息列表，
 *   按 plan.id 和 planFilePath 双重防重，避免回放流与历史恢复卡产出同内容重复
 * - getActiveSessionPlan / applyActiveSessionPlan：当前 session 的活跃方案读写
 *
 * ## 防重说明
 * 历史恢复卡（从磁盘 load 的完整方案）与回放流中的 plan_update（从日志 replay 的
 * 增量事件）描述的是同一个文件，但 id 不同。仅靠 id 去重会漏掉，所以额外按
 * planFilePath 防重——文件路径相同的消息只保留一份。
 *
 * ## 维护
 * - HistoricalSessionPlan.planFilePath 相对项目根目录。
 * - 回放时 plan 的插入顺序需与首次产生顺序一致。
 */
import type { ChatMessage } from '../types';

export type HistoricalSessionPlan = {
  id: string;
  toolCallId: string;
  planFilePath: string;
  content: string;
};

export type ActiveSessionPlan =
  { active: false } | { active: true; planFilePath: string; content: string | null };

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
  return plans.filter((plan): plan is HistoricalSessionPlan => {
    if (typeof plan !== 'object' || plan === null) return false;
    // plan is deserialized JSON; validate shape before asserting HistoricalSessionPlan
    const p = plan as Record<string, unknown>;
    return (
      typeof p.id === 'string' &&
      typeof p.toolCallId === 'string' &&
      typeof p.planFilePath === 'string' &&
      typeof p.content === 'string'
    );
  });
};

export const insertHistoricalPlans = (messages: ChatMessage[], plans: HistoricalSessionPlan[]) => {
  const next = [...messages];
  for (const plan of plans) {
    // 同 id 精确去重；planFilePath 兜底——历史恢复卡与回放流中 plan_update
    // 产生的同文件路径消息不应重复出现。
    if (
      next.some(
        (message) =>
          message.id === plan.id ||
          (message.planFilePath !== undefined && message.planFilePath === plan.planFilePath),
      )
    ) {
      continue;
    }
    const planMessage: ChatMessage = {
      id: plan.id,
      role: 'plan',
      text: plan.content,
      planId: plan.id,
      planContentType: 'markdown',
      planFilePath: plan.planFilePath,
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
    content: plan.content,
  };
};

export const applyActiveSessionPlan = (messages: ChatMessage[], plan: ActiveSessionPlan) => {
  const withoutPreviousActive = messages.filter((message) => !message.planActive);
  if (!plan.active) return withoutPreviousActive;
  const withoutDuplicate = withoutPreviousActive.filter(
    (message) => !message.planPending && message.planFilePath !== plan.planFilePath,
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
    },
  ];
};
