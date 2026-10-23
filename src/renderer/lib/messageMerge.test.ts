import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../electron/types.js';
import { mergeAgentEventIntoMessages } from './messageMerge.js';

describe('ACP 后台任务', () => {
  it('回合结束后后台工具继续运行并接收最终输出，保留工具标题', () => {
    let messages = mergeAgentEventIntoMessages([], {
      sessionId: 's1',
      type: 'tool_call',
      message: 'Background bash',
      payload: {
        update: {
          toolCallId: 'bg',
          status: 'completed',
          rawOutput: { details: { async: { state: 'running' } } },
        },
      },
    });
    messages = mergeAgentEventIntoMessages(messages, {
      sessionId: 's1',
      type: 'done',
      message: 'done',
      payload: { stopReason: 'end_turn' },
    });
    expect(messages[0].toolStatus).toBe('in_progress');
    messages = mergeAgentEventIntoMessages(messages, {
      sessionId: 's1',
      type: 'tool_call',
      message: '',
      payload: {
        update: {
          toolCallId: 'bg',
          status: 'completed',
          rawOutput: { details: { async: { state: 'completed' } } },
          content: [{ type: 'content', content: { type: 'text', text: 'finished' } }],
        },
      },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      text: 'Background bash',
      toolStatus: 'completed',
      toolOutput: 'finished',
    });
  });

  it('正常回合结束仍收敛前台工具，进程关闭时收敛后台工具', () => {
    const foreground = mergeAgentEventIntoMessages([], {
      sessionId: 's1',
      type: 'tool_call',
      message: 'Foreground',
      payload: { update: { toolCallId: 'fg', status: 'in_progress' } },
    });
    const background = mergeAgentEventIntoMessages(foreground, {
      sessionId: 's1',
      type: 'tool_call',
      message: 'Background',
      payload: {
        update: {
          toolCallId: 'bg',
          status: 'in_progress',
          rawOutput: { details: { async: { state: 'running' } } },
        },
      },
    });
    const ended = mergeAgentEventIntoMessages(background, {
      sessionId: 's1',
      type: 'done',
      message: 'done',
      payload: { stopReason: 'end_turn' },
    });
    expect(ended.map((message) => message.toolStatus)).toEqual(['failed', 'in_progress']);
    const closed = mergeAgentEventIntoMessages(ended, {
      sessionId: 's1',
      type: 'done',
      message: 'Process closed',
    });
    expect(closed.map((message) => message.toolStatus)).toEqual(['failed', 'failed']);
  });
});

describe('ACP 请求撤销记录', () => {
  it('仅将撤销目标的待处理记录标为取消，已提交结果与其它记录保持原状', () => {
    const messages = mergeAgentEventIntoMessages(
      [
        {
          id: 'pending',
          role: 'elicitation',
          text: 'Pending',
          elicitationRequestId: 'r1',
          elicitationStatus: 'pending',
        },
        {
          id: 'accepted',
          role: 'elicitation',
          text: 'Accepted',
          elicitationRequestId: 'r2',
          elicitationStatus: 'accepted',
        },
        {
          id: 'other',
          role: 'elicitation',
          text: 'Other',
          elicitationRequestId: 'r3',
          elicitationStatus: 'pending',
        },
      ],
      {
        sessionId: 's1',
        type: 'request_cancelled',
        message: 'cancelled',
        payload: { requestId: 'r1' },
      },
    );
    expect(messages.map((message) => message.elicitationStatus)).toEqual([
      'cancelled',
      'accepted',
      'pending',
    ]);
    expect(messages).toHaveLength(3);
  });
});

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
