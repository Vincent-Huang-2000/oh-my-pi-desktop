import type { ChatMessage, QuestionnaireAnswer } from '../types';
import { getElicitationResultText } from '../lib/elicitationText';
import type { useAppCore } from './useAppCore';

export function useApprovalFlow(app: ReturnType<typeof useAppCore>) {
  // 把指定 requestId 的问卷从队列移除，并推进当前弹窗到下一项或置空。
  const advanceToNextQuestionnaire = (requestId: string, sessionId: string) => {
    const remaining = (app.questionnaireBySession.current[sessionId] ?? []).filter(
      (request) => request.requestId !== requestId
    );
    app.questionnaireBySession.current[sessionId] = remaining;
    if (app.selectedSessionRef.current?.id === sessionId) {
      app.setQuestionnaireRequest(remaining[0] ?? null);
    }
  };

  // 权限审批：调用 IPC 后清理当前 session 的弹窗缓存（其它 session 的不受影响）。
  const handlePermission = async (optionId: string) => {
    if (!app.permissionRequest || !app.selectedSession) {
      return;
    }
    const sessionId = app.selectedSession.id;
    const requestId = app.permissionRequest.requestId;
    const result = await window.ohMyPiDesktop.permissionOptionResponse(requestId, optionId);
    if (!result.ok) {
      app.setAgentStatus('审批失败');
      return;
    }
    const remaining = (app.permissionBySession.current[sessionId] ?? []).filter(
      (request) => request.requestId !== requestId
    );
    app.permissionBySession.current[sessionId] = remaining;
    if (app.selectedSessionRef.current?.id === sessionId) {
      const nextRequest = remaining[0] ?? null;
      app.setPermissionRequest(nextRequest);
      const nextIsPermission = nextRequest?.options.some(
        (option) => option.kind.startsWith('allow') || option.kind.startsWith('reject')
      );
      app.setAgentStatus(nextRequest ? (nextIsPermission ? '等待审批' : '等待选择') : '继续运行');
    }
  };

  // elicitation 响应：工具审批与 AskTool 共用，action 为 accept（携带 content）/ decline / cancel。
  const handleElicitation = async (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ) => {
    if (!app.selectedSession) {
      return;
    }
    const sessionId = app.selectedSession.id;
    const matched = (app.elicitationBySession.current[sessionId] ?? []).find(
      (item) => item.requestId === requestId
    );
    if (!matched) {
      return;
    }
    const requestKind = matched.kind;
    const submittingText = requestKind === 'question' ? '正在提交选择…' : '正在提交确认…';
    const markSubmitting = (current: ChatMessage[]) => current.map((message) =>
      message.elicitationRequestId === requestId
        ? { ...message, elicitationStatus: 'submitting' as const, elicitationResult: submittingText }
        : message
    );
    app.setAgentStatus(requestKind === 'question' ? '正在提交选择' : '正在提交确认');
    app.setMessages((current) => {
      const next = markSubmitting(current);
      app.messageCache.current[sessionId] = next;
      return next;
    });
    const result = await window.ohMyPiDesktop.elicitationResponse(requestId, action, content);
    const updateElicitationRecord = (
      status: NonNullable<ChatMessage['elicitationStatus']>,
      resultText: string
    ) => {
      const updateMessages = (current: ChatMessage[]) => current.map((message) => {
        if (message.elicitationRequestId === requestId) {
          return { ...message, elicitationStatus: status, elicitationResult: resultText };
        }
        if (message.planPreviewRequestId === requestId && status !== 'failed') {
          return { ...message, planPreview: false, planPreviewRequestId: undefined };
        }
        return message;
      });
      if (app.selectedSessionRef.current?.id === sessionId) {
        app.setMessages((current) => {
          const next = updateMessages(current);
          app.messageCache.current[sessionId] = next;
          return next;
        });
      } else {
        app.messageCache.current[sessionId] = updateMessages(app.messageCache.current[sessionId] ?? []);
      }
    };
    const remaining = (app.elicitationBySession.current[sessionId] ?? []).filter(
      (request) => request.requestId !== requestId
    );
    app.elicitationBySession.current[sessionId] = remaining;
    if (!result.ok) {
      updateElicitationRecord('failed', '确认失败：请求已失效');
      if (app.selectedSessionRef.current?.id === sessionId) {
        app.setElicitationRequest(remaining[0] ?? null);
        app.setAgentStatus(remaining[0]
          ? (remaining[0].kind === 'question' ? '等待选择' : '等待确认')
          : (requestKind === 'question' ? '提交失败' : '确认失败'));
      }
      return;
    }
    const elicitationResult = getElicitationResultText(matched, action, content);
    updateElicitationRecord(
      action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled',
      elicitationResult
    );
    if (app.selectedSessionRef.current?.id === sessionId) {
      app.setElicitationRequest(remaining[0] ?? null);
      app.setAgentStatus(remaining[0]
        ? (remaining[0].kind === 'question' ? '等待选择' : '等待确认')
        : '继续运行');
    }
  };

  // 兼容问卷响应：提交会隐式批准该 eval，答案由主进程等当前回合结束后安全续发。
  const handleQuestionnaire = async (
    requestId: string,
    action: 'submit' | 'deny',
    answers?: QuestionnaireAnswer[]
  ) => {
    if (!app.selectedSession) {
      return false;
    }
    const sessionId = app.selectedSession.id;
    const requestExists = (app.questionnaireBySession.current[sessionId] ?? []).some(
      (request) => request.requestId === requestId
    );
    if (!requestExists) {
      return false;
    }
    const updateRecord = (
      status: NonNullable<ChatMessage['elicitationStatus']>,
      resultText: string
    ) => {
      const updateMessages = (current: ChatMessage[]) => current.map((message) =>
        message.elicitationRequestId === requestId
          ? { ...message, elicitationStatus: status, elicitationResult: resultText }
          : message
      );
      if (app.selectedSessionRef.current?.id === sessionId) {
        app.setMessages((current) => {
          const next = updateMessages(current);
          app.messageCache.current[sessionId] = next;
          return next;
        });
      } else {
        app.messageCache.current[sessionId] = updateMessages(app.messageCache.current[sessionId] ?? []);
      }
    };
    if (action === 'submit') {
      updateRecord('submitting', '已提交选择，正在完成当前步骤…');
      if (app.selectedSessionRef.current?.id === sessionId) app.setAgentStatus('正在提交问卷答案');
    }
    const result = await window.ohMyPiDesktop.questionnaireResponse(requestId, action, answers);
    if (!result.ok) {
      if (result.reason === 'stale') {
        updateRecord('failed', '问卷请求已失效');
        advanceToNextQuestionnaire(requestId, sessionId);
        if (app.selectedSessionRef.current?.id === sessionId) {
          const next = app.questionnaireBySession.current[sessionId]?.[0];
          app.setAgentStatus(next ? '等待选择' : '继续运行');
        }
        return false;
      }
      updateRecord('failed', result.message ?? '问卷提交失败，请重新选择');
      if (app.selectedSessionRef.current?.id === sessionId) app.setAgentStatus('问卷提交失败');
      return false;
    }
    advanceToNextQuestionnaire(requestId, sessionId);
    if (action === 'deny') {
      updateRecord('declined', '已拒绝问卷');
    }
    if (app.selectedSessionRef.current?.id === sessionId) {
      app.setAgentStatus(action === 'submit' ? '已提交选择，等待当前步骤完成' : '已拒绝问卷');
    }
    return true;
  };

  return { handlePermission, handleElicitation, handleQuestionnaire };
}
