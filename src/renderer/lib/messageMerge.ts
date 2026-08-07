/**
 * messageMerge — Agent 事件消息合流核心逻辑。
 *
 * mergeAgentEventIntoMessages(event, messages, plansPath, toolGroups) 是
 * agent 事件流与 UI 消息列表之间的核心桥接函数（~170 行）。处理：
 * - 按 messageId 查找现有消息行进行增量更新（plan/tool_call/tool_result/elicitation）
 * - 新消息追加（assistant 文本、计划摘要卡、usage 行等）
 * - tool 组折叠状态联动（回合开始时展开、done 后折叠）
 *
 * isPlanToolCall(toolCall)：判断某 tool_call 是否为 plan 工具调用。
 *
 * ## 维护
 * - 本函数是渲染进程中对 agent 事件格式最敏感的部分，修改前需逐一确认各种 payload 结构。
 * - 所有事件类型的分支应保持防御性：未知 payload 只打印日志，不抛异常。
 */
import type { ChatMessage } from '../types';
import {
  getMessageRole,
  getPayloadMessageId,
  getPayloadPlanChange,
  getPayloadToolCall
} from '../utils';

// ACP 没有单独的「开始创建计划」事件；通过计划工具标题识别其执行阶段，
// 先插入可见占位卡，收到正式 plan 事件后再替换为完整计划。
const isPlanToolCall = (title: string) => {
  const normalized = title.trim().toLowerCase();
  return (
    normalized.includes('update_plan') ||
    /\b(create|creating|update|updating|write|writing)\s+(the\s+)?plan\b/.test(normalized) ||
    /(创建|生成|更新|编写|制定).*计划/.test(normalized)
  );
};

export const mergeAgentEventIntoMessages = (
  current: ChatMessage[],
  event: AgentEvent,
  currentModel?: ChatMessage['toolModel']
): ChatMessage[] => {
  const messageId = getPayloadMessageId(event.payload);
  const role = getMessageRole(event.type);

  /* 流式文本合并：回答、思考与用户消息按 messageId + role 分别累积，
     避免 omp 复用 messageId 时把思考过程拼进最终回答。 */
  if (messageId && (role === 'agent' || role === 'thought' || role === 'user')) {
    const existing = current.find((message) => message.id === messageId && message.role === role);
    if (existing) {
      return current.map((message) =>
        message.id === messageId && message.role === role
          ? { ...message, text: `${message.text}${event.message}` }
          : message
      );
    }
    return [...current, { id: messageId, role, text: event.message }];
  }

  /* 工具调用：按 toolCallId 去重/更新，携带结构化数据 */
  if (event.type === 'tool_call') {
    const toolData = getPayloadToolCall(event.payload);
    const appendPlanPending = (messages: ChatMessage[]) => {
      const canStartPlan = !toolData.status || toolData.status === 'pending' || toolData.status === 'in_progress';
      if (
        !canStartPlan ||
        !isPlanToolCall(toolData.title || event.message) ||
        messages.some((message) => message.planPending)
      ) {
        return messages;
      }
      return [
        ...messages,
        {
          id: `plan-pending-${toolData.toolCallId || Date.now()}`,
          role: 'plan' as const,
          text: 'Agent 正在整理任务步骤，完成后将在这里展示完整计划。',
          planPending: true
        }
      ];
    };
    const existing = current.find(
      (message) => message.toolCallId && message.toolCallId === toolData.toolCallId
    );
    if (existing) {
      const updated = current.map((message) =>
        message.toolCallId === toolData.toolCallId
          ? {
              ...message,
              text: event.message,
              toolKind: (toolData.kind ?? message.toolKind) as ChatMessage['toolKind'],
              toolStatus: (toolData.status ?? message.toolStatus) as ChatMessage['toolStatus'],
              toolLocations: toolData.locations ?? message.toolLocations,
              toolDiffs: toolData.diffs ?? message.toolDiffs,
              toolOutput: toolData.output ?? message.toolOutput,
              toolModel: toolData.toolModel ?? message.toolModel
            }
          : message
      );
      return appendPlanPending(updated);
    }
    // 仅在实时事件时使用当前模型快照；历史 replay 事件优先使用主进程带回的快照。
    const isReplay =
      typeof event.payload === 'object' &&
      event.payload !== null &&
      (event.payload as Record<string, unknown>)._replay === true;
    const toolModel = toolData.toolModel ?? (!isReplay ? currentModel : undefined);
    return appendPlanPending([
      ...current,
      {
        id: messageId || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role,
        text: event.message,
        toolCallId: toolData.toolCallId,
        toolKind: toolData.kind as ChatMessage['toolKind'],
        toolStatus: toolData.status as ChatMessage['toolStatus'],
        toolLocations: toolData.locations,
        toolDiffs: toolData.diffs,
        toolOutput: toolData.output,
        toolModel
      }
    ]);
  }

  /* 旧 plan 只替换无 ID 的结构化执行清单；方案文档与执行进度是两类信息，必须并存。
     plan_update / plan_removed 仍按 planId 精确更新对应计划。 */
  if (event.type === 'plan') {
    const change = getPayloadPlanChange(event.payload);
    if (!change) return current;
    if (change.action === 'remove') {
      return current.filter((message) => message.role !== 'plan' || message.planId !== change.planId);
    }
    const withoutReplacedPlan = current.filter((message) => {
      if (message.role !== 'plan') return true;
      if (message.planPending) return false;
      if (change.planId) return message.planId !== change.planId;
      return message.planContentType !== 'items' || !!message.planId;
    });
    return [
      ...withoutReplacedPlan,
      {
        id: change.planId ?? `plan-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'plan' as const,
        text: change.text ?? event.message,
        planId: change.planId,
        planContentType: change.contentType,
        planEntries: change.contentType === 'items' ? change.entries : undefined
      }
    ];
  }

  /* Plan 模式占位卡只用于等待正式 plan；回合结束/报错仍未收到 plan 时自动清理。
     同时收敛没有收到 tool_call_update 终态的工具，避免 ACP 取消、进程退出或协议丢包后卡片永久转圈。 */
  if (event.type === 'done' || event.type === 'error') {
    const withoutPendingPlan = current.filter((message) => !message.planPending);
    const payload = event.payload && typeof event.payload === 'object'
      ? event.payload as Record<string, unknown>
      : undefined;
    const stopReason = typeof payload?.stopReason === 'string' ? payload.stopReason : '';
    const unresolvedToolResult = event.type === 'error'
      ? `工具调用因回合错误而中止：${event.message}`
      : stopReason === 'cancelled'
        ? '工具调用已随当前回合取消。'
        : '回合已结束，但未收到工具调用的完成状态。';
    const settledMessages = withoutPendingPlan.map((message) => {
      if (
        message.role !== 'tool' ||
        (message.toolStatus !== undefined && message.toolStatus !== 'pending' && message.toolStatus !== 'in_progress')
      ) {
        return message;
      }
      return {
        ...message,
        toolStatus: 'failed' as const,
        toolOutput: message.toolOutput
          ? `${message.toolOutput}\n\n${unresolvedToolResult}`
          : unresolvedToolResult
      };
    });
    return [
      ...settledMessages,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role,
        text: event.message
      }
    ];
  }

  return [
    ...current,
    {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role,
      text: event.message
    }
  ];
};
