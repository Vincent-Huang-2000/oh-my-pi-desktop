/**
 * messageMerge — Agent 事件流 → UI 消息列表的合流核心。
 *
 * mergeAgentEventIntoMessages(event, messages, …) 是唯一入口（~170 行），
 * 负责将 ACP 子进程发来的每条事件转换为消息列表的增删改。处理的事件类型：
 * - assistant 文本 → 原地追加或新建消息行
 * - tool_call / tool_result → 增量更新工具卡片的标题、状态、输出
 * - plan / plan_update → 按 planId 替换旧 plan 消息，同时清理 planPending
 *   占位、planPreview 预览卡、旧协议无 id 的 items 列表（详见 plan 分支注释）
 * - elicitation → 按 requestId 原地更新审批结果
 * - done / error → 清理未收到正式 plan 的占位卡，收敛未终结的工具卡
 *
 * 注意：本函数只做“我知道谁替换谁”的精确去重（planId 相同 / pending→正式 /
 * preview→正式）。它不负责“同类型多条消息只保留最后一条”的去重——那是
 * TurnBlock 渲染层的职责，因为历史恢复 / 多回合 replay 产生的同类型残留没有
 * planId 可追溯，只能在渲染时按 contentType 收敛。
 *
 * ## 维护
 * - 本函数对 agent 事件格式最敏感，修改前需逐一确认各 payload 结构。
 * - 所有事件分支保持防御性：未知 payload 只打印日志，不抛异常。
 */
import type { ChatMessage } from '../types';
import {
  getMessageRole,
  getPayloadMessageId,
  getPayloadPlanChange,
  getPayloadToolCall,
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
  currentModel?: ChatMessage['toolModel'],
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
          : message,
      );
    }
    return [...current, { id: messageId, role, text: event.message }];
  }

  /* 工具调用：按 toolCallId 去重/更新，携带结构化数据 */
  if (event.type === 'tool_call') {
    const toolData = getPayloadToolCall(event.payload);
    const appendPlanPending = (messages: ChatMessage[]) => {
      const canStartPlan =
        !toolData.status || toolData.status === 'pending' || toolData.status === 'in_progress';
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
          planPending: true,
        },
      ];
    };
    const existing = current.find(
      (message) => message.toolCallId && message.toolCallId === toolData.toolCallId,
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
              toolModel: toolData.toolModel ?? message.toolModel,
            }
          : message,
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
        toolModel,
      },
    ]);
  }

  /* 这里的去重是“一条消息替换另一条”的精确替换，因为事件携带了 planId 能确认身份：
     planId 匹配 → 直接替换；planPending 占位 → 正式版替代；planPreview 预览 → 正式版替代；
     旧协议无 id 的 items → 新协议替代。
     不处理“同 content 类型多条但你不替换我”的重复——那种跨来源重复没有 planId 可查，
     留到 TurnBlock 渲染时按 contentType 只保留最后一条。 */
  if (event.type === 'plan') {
    const change = getPayloadPlanChange(event.payload);
    if (!change) return current;
    if (change.action === 'remove') {
      return current.filter(
        (message) => message.role !== 'plan' || message.planId !== change.planId,
      );
    }
    const withoutReplacedPlan = current.filter((message) => {
      if (message.role !== 'plan') return true;
      // 始终移除 planPending 占位——它们会被正式 plan 替代
      if (message.planPending) return false;
      if (change.planId) {
        // 同 planId 的卡被精确替换
        if (message.planId === change.planId) return false;
        // markdown 正式 plan 到达时，清除所有 planPreview 残留预览卡
        //（它们是同一审批流程的中间产物，正式版已替代预览版）
        if (change.contentType === 'markdown' && message.planPreview) return false;
        // items 类正式 plan 到达时，清除无 id 的旧版 items 卡
        //（这些是 agent 用旧协议发出的临时列表，新版带 planId 的已替代它们）
        if (
          change.contentType === 'items' &&
          message.planContentType === 'items' &&
          !message.planId
        ) {
          return false;
        }
        return true;
      }
      // change 无 planId：保持旧版行为，只替换无 id 的 items 卡
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
        planEntries: change.contentType === 'items' ? change.entries : undefined,
      },
    ];
  }

  /* Plan 模式占位卡只用于等待正式 plan；回合结束/报错仍未收到 plan 时自动清理。
     同时收敛没有收到 tool_call_update 终态的工具，避免 ACP 取消、进程退出或协议丢包后卡片永久转圈。 */
  if (event.type === 'done' || event.type === 'error') {
    const withoutPendingPlan = current.filter((message) => !message.planPending);
    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : undefined;
    const stopReason = typeof payload?.stopReason === 'string' ? payload.stopReason : '';
    const unresolvedToolResult =
      event.type === 'error'
        ? `工具调用因回合错误而中止：${event.message}`
        : stopReason === 'cancelled'
          ? '工具调用已随当前回合取消。'
          : '回合已结束，但未收到工具调用的完成状态。';
    const settledMessages = withoutPendingPlan.map((message) => {
      if (
        message.role !== 'tool' ||
        (message.toolStatus !== undefined &&
          message.toolStatus !== 'pending' &&
          message.toolStatus !== 'in_progress')
      ) {
        return message;
      }
      return {
        ...message,
        toolStatus: 'failed' as const,
        toolOutput: message.toolOutput
          ? `${message.toolOutput}\n\n${unresolvedToolResult}`
          : unresolvedToolResult,
      };
    });
    // 正常 end_turn 和 cancelled 都静默完成：前者状态栏已有"完成"，后者已有 "已请求取消当前回合" 即时反馈。
    // 只有 error 才追加错误消息到对话流。
    if (event.type === 'error') {
      return [
        ...settledMessages,
        { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, role, text: event.message },
      ];
    }
    return settledMessages;
  }

  return [
    ...current,
    {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role,
      text: event.message,
    },
  ];
};
