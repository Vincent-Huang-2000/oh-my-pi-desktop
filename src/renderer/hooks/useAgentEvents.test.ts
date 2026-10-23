import { createElement, type Dispatch, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, QuestionnaireRequest } from '../types';
import { useAgentEvents } from './useAgentEvents';
import type { RunModeCapabilities } from '../lib/runModeCapabilities';

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
  const capabilities = createState<Record<string, RunModeCapabilities>>({});
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
    setRunModeCapabilitiesBySession: capabilities.set,
    setDesktopState: vi.fn(),
    setAvailableCommands: vi.fn(),
    setAcpConfigOptions: vi.fn(),
    modelBySessionRef: { current: {} },
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
  return {
    app,
    requests,
    selected,
    cancel,
    capabilities,
    emit: (event: AgentEvent) => listener!(event),
  };
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

describe('运行模式能力的实时来源与隔离', () => {
  it('仅更新事件所属会话，模式和命令独立到达时保留另一项', () => {
    const { capabilities, emit } = createHarness();
    emit({
      sessionId: 's2',
      type: 'commands_update',
      message: '',
      payload: { commands: [{ name: 'guided-goal', description: '引导目标' }] },
    });
    expect(capabilities.get().s1).toBeUndefined();
    expect(capabilities.get().s2.commands).toEqual(['guided-goal']);
    emit({
      sessionId: 's2',
      type: 'config_update',
      message: '',
      payload: { configOptions: [{ id: 'mode', options: [{ value: 'goal', name: 'Goal' }] }] },
    });
    expect(capabilities.get().s2).toEqual({ commands: ['guided-goal'], modes: ['goal'] });
  });

  it('空命令列表表示已经检测，进程停止后回到未知且不清除其他会话', () => {
    const { capabilities, emit } = createHarness();
    for (const sessionId of ['s1', 's2']) {
      emit({ sessionId, type: 'commands_update', message: '', payload: { commands: [] } });
    }
    expect(capabilities.get().s1.commands).toEqual([]);
    emit({ sessionId: 's2', type: 'process_stopped', message: '' });
    expect(capabilities.get().s2).toBeUndefined();
    expect(capabilities.get().s1).toEqual({ commands: [] });
  });
});
