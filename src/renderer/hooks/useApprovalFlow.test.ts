import { createElement, type Dispatch, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAgentEventIntoMessages } from '../lib/messageMerge';
import type { ChatMessage, ElicitationRequest, QuestionnaireRequest } from '../types';
import { useApprovalFlow } from './useApprovalFlow';

afterEach(() => vi.unstubAllGlobals());

const createState = <T>(initial: T) => {
  let value = initial;
  const set: Dispatch<SetStateAction<T>> = (update) => {
    value = typeof update === 'function' ? (update as (current: T) => T)(value) : update;
  };
  return { get: () => value, set };
};

// 模拟提交 IPC 往返期间先到达的 request_cancelled：移出队列并标记记录，随后 IPC 返回失效。
const createHarness = (cancelDuringSubmit: boolean) => {
  const elicitation: ElicitationRequest = {
    requestId: 'r1',
    message: 'Confirm',
    fields: [],
    kind: 'approval',
  };
  const questionnaire: QuestionnaireRequest = { requestId: 'q1', questions: [] };
  const messages = createState<ChatMessage[]>([
    {
      id: 'elicitation-r1',
      role: 'elicitation',
      text: 'Confirm',
      elicitationRequestId: 'r1',
      elicitationStatus: 'pending',
    },
    {
      id: 'questionnaire-q1',
      role: 'elicitation',
      text: 'Q',
      elicitationRequestId: 'q1',
      elicitationKind: 'questionnaire',
      elicitationStatus: 'pending',
    },
  ]);
  const app = {
    selectedSession: { id: 's1' },
    selectedSessionRef: { current: { id: 's1' } },
    permissionBySession: { current: { s1: [] } },
    elicitationBySession: { current: { s1: [elicitation] } as Record<string, unknown[]> },
    questionnaireBySession: { current: { s1: [questionnaire] } as Record<string, unknown[]> },
    messageCache: { current: {} },
    setMessages: messages.set,
    setAgentStatus: vi.fn(),
    setElicitationRequest: vi.fn(),
    setQuestionnaireRequest: vi.fn(),
  };
  const cancel = (requestId: string, queue: 'elicitationBySession' | 'questionnaireBySession') => {
    if (!cancelDuringSubmit) return;
    app[queue].current.s1 = [];
    messages.set((current) =>
      mergeAgentEventIntoMessages(current, {
        sessionId: 's1',
        type: 'request_cancelled',
        message: '输入请求已取消',
        payload: { requestId },
      }),
    );
  };
  vi.stubGlobal('window', {
    ohMyPiDesktop: {
      elicitationResponse: () => {
        cancel('r1', 'elicitationBySession');
        return Promise.resolve({ ok: false, message: '输入请求已失效' });
      },
      questionnaireResponse: () => {
        cancel('q1', 'questionnaireBySession');
        return Promise.resolve({ ok: false, message: '问卷请求已失效', reason: 'stale' });
      },
    },
  });
  let flow: ReturnType<typeof useApprovalFlow> | undefined;
  function ApprovalFlow() {
    flow = useApprovalFlow(app as unknown as Parameters<typeof useApprovalFlow>[0]);
    return null;
  }
  renderToStaticMarkup(createElement(ApprovalFlow));
  const statusOf = (requestId: string) =>
    messages.get().find((message) => message.elicitationRequestId === requestId);
  return { app, flow: flow!, statusOf };
};

describe('提交与撤销竞态', () => {
  it('提交期间被撤销的输入表单保留已取消记录，不改报确认失败', async () => {
    const { app, flow, statusOf } = createHarness(true);
    await flow.handleElicitation('r1', 'accept', { value: 'yes' });
    expect(statusOf('r1')).toMatchObject({
      elicitationStatus: 'cancelled',
      elicitationResult: '已取消',
    });
    expect(app.setAgentStatus).not.toHaveBeenCalledWith('确认失败');
    expect(app.setElicitationRequest).not.toHaveBeenCalled();
  });

  it('提交期间被撤销的问卷保留已取消记录，不重复推进', async () => {
    const { app, flow, statusOf } = createHarness(true);
    expect(await flow.handleQuestionnaire('q1', 'submit', [])).toBe(false);
    expect(statusOf('q1')).toMatchObject({
      elicitationStatus: 'cancelled',
      elicitationResult: '已取消',
    });
    expect(app.setQuestionnaireRequest).not.toHaveBeenCalled();
    expect(app.setAgentStatus).not.toHaveBeenCalledWith('继续运行');
  });

  it('未被撤销的失效请求仍按失败处理', async () => {
    const { app, flow, statusOf } = createHarness(false);
    await flow.handleElicitation('r1', 'accept', { value: 'yes' });
    await flow.handleQuestionnaire('q1', 'submit', []);
    expect(statusOf('r1')).toMatchObject({ elicitationStatus: 'failed' });
    expect(statusOf('q1')).toMatchObject({ elicitationStatus: 'failed' });
    expect(app.setAgentStatus).toHaveBeenCalledWith('确认失败');
    expect(app.setQuestionnaireRequest).toHaveBeenCalledWith(null);
  });
});
