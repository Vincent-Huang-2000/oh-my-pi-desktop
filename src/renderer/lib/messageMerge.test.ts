import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../electron/types.js';
import { mergeAgentEventIntoMessages } from './messageMerge.js';

describe('Plan proposal pending card', () => {
  it('仅为主进程结构化标记的 xd://propose 创建一次占位卡', () => {
    const start: AgentEvent = {
      sessionId: 'session-1',
      type: 'tool_call',
      message: 'xd://propose',
      payload: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'proposal-1',
          title: 'xd://propose',
          status: 'pending',
          rawInput: { path: 'xd://propose', content: 'auth' },
        },
        planProposal: { toolCallId: 'proposal-1', title: 'auth' },
      },
    };
    const afterStart = mergeAgentEventIntoMessages([], start);
    expect(afterStart.filter((message) => message.planPending)).toHaveLength(1);

    const afterUpdate = mergeAgentEventIntoMessages(afterStart, {
      sessionId: 'session-1',
      type: 'tool_call',
      message: 'xd://propose',
      payload: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'proposal-1',
          status: 'in_progress',
        },
        planProposal: { toolCallId: 'proposal-1', title: 'auth' },
      },
    });
    expect(afterUpdate.filter((message) => message.planPending)).toHaveLength(1);
  });

  it('不再根据工具标题猜测 Plan proposal', () => {
    const messages = mergeAgentEventIntoMessages([], {
      sessionId: 'session-1',
      type: 'tool_call',
      message: 'Create plan',
      payload: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ordinary-write',
          title: 'Create plan',
          status: 'pending',
        },
      },
    });

    expect(messages.some((message) => message.planPending)).toBe(false);
  });
});
