import { createElement, type Dispatch, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, QuestionnaireRequest } from '../types';
import { useAgentEvents } from './useAgentEvents';

// 测试真实事件订阅与状态更新；仅将 effect 的挂载改为同步，避免依赖浏览器环境。
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (setup: () => unknown) => setup(),
}));

afterEach(() => vi.unstubAllGlobals());

const createState = <T>(initial: T) => {
  let value = initial;
  const set: Dispatch<SetStateAction<T>> = (update) => {
    value = typeof update === 'function' ? (update as (current: T) => T)(value) : update;
  };
  return { get: () => value, set };
};

const createHarness = () => {
  const requests: QuestionnaireRequest[] = ['a', 'b', 'c'].map((requestId) => ({
    requestId,
    questions: [],
  }));
  const selected = createState<QuestionnaireRequest | null>(requests[2]);
  const messages = createState<ChatMessage[]>([]);
  let listener: ((event: AgentEvent) => void) | undefined;
  vi.stubGlobal('window', {
    ohMyPiDesktop: {
      onAgentEvent: (callback: (event: AgentEvent) => void) => {
        listener = callback;
        return () => {};
      },
    },
  });
  const app = {
    permissionBySession: { current: { s1: [] } },
    elicitationBySession: { current: { s1: [] } },
    questionnaireBySession: { current: { s1: requests, s2: [requests[1]] } },
    selectedSessionRef: { current: { id: 's1' } },
    messageCache: { current: {} },
    setPermissionRequest: vi.fn(),
    setElicitationRequest: vi.fn(),
    setQuestionnaireRequest: selected.set,
    setMessages: messages.set,
    setAgentStatus: vi.fn(),
  };
  function EventSubscription() {
    useAgentEvents(
      app as unknown as Parameters<typeof useAgentEvents>[0],
      {} as Parameters<typeof useAgentEvents>[1],
      () => Promise.resolve(null),
      () => Promise.resolve(),
      { handleTurnSettled: vi.fn(), handleSessionReplaced: vi.fn() },
    );
    return null;
  }
  renderToStaticMarkup(createElement(EventSubscription));
  const cancel = (requestId: string, sessionId = 's1') => {
    listener!({
      sessionId,
      type: 'request_cancelled',
      message: '输入请求已取消',
      payload: { requestId },
    });
  };
  return { app, requests, selected, cancel };
};

describe('请求撤销与当前问卷选择', () => {
  it('撤销另一份问卷时保留当前选择及对象引用，避免表单卸载', () => {
    const { app, requests, selected, cancel } = createHarness();
    cancel('b');
    expect(app.questionnaireBySession.current.s1).toEqual([requests[0], requests[2]]);
    expect(selected.get()).toBe(requests[2]);
  });

  it('撤销当前问卷时推进剩余队首，全部撤销后关闭表单', () => {
    const { requests, selected, cancel } = createHarness();
    cancel('c');
    expect(selected.get()).toBe(requests[0]);
    cancel('a');
    expect(selected.get()).toBe(requests[1]);
    cancel('b');
    expect(selected.get()).toBeNull();
  });

  it('重复或未知撤销不改变仍有效的当前选择', () => {
    const { requests, selected, cancel } = createHarness();
    cancel('unknown');
    expect(selected.get()).toBe(requests[2]);
    cancel('b');
    cancel('b');
    expect(selected.get()).toBe(requests[2]);
  });

  it('其他会话的撤销只清理目标队列，不影响当前会话选择', () => {
    const { app, requests, selected, cancel } = createHarness();
    cancel('b', 's2');
    expect(app.questionnaireBySession.current.s2).toEqual([]);
    expect(app.questionnaireBySession.current.s1).toEqual(requests);
    expect(selected.get()).toBe(requests[2]);
  });
});
