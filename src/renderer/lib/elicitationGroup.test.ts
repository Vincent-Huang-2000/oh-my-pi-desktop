import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types';
import {
  getElicitationTitle,
  groupElicitationMessages,
  isResolvedElicitation,
} from './elicitationGroup';

const elicitation = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1',
  role: 'elicitation',
  text: '问题',
  elicitationStatus: 'accepted',
  elicitationKind: 'question',
  ...overrides,
});

describe('getElicitationTitle', () => {
  it('已解决的 question 记录显示为「问答记录」，工具审批显示为「确认记录」', () => {
    expect(getElicitationTitle(elicitation({}))).toBe('问答记录');
    expect(getElicitationTitle(elicitation({ elicitationKind: undefined }))).toBe('确认记录');
  });

  it('pending/submitting/failed 按状态与 kind 派生标题', () => {
    expect(
      getElicitationTitle(
        elicitation({ elicitationStatus: 'pending', elicitationKind: 'questionnaire' }),
      ),
    ).toBe('等待选择');
    expect(getElicitationTitle(elicitation({ elicitationStatus: 'submitting' }))).toBe(
      '正在提交选择',
    );
    expect(getElicitationTitle(elicitation({ elicitationStatus: 'failed' }))).toBe('回答提交失败');
    expect(
      getElicitationTitle(elicitation({ elicitationStatus: 'failed', elicitationKind: undefined })),
    ).toBe('确认失败');
  });
});

describe('isResolvedElicitation', () => {
  it('仅 accepted/declined/cancelled 视为已解决', () => {
    expect(isResolvedElicitation(elicitation({}))).toBe(true);
    expect(isResolvedElicitation(elicitation({ elicitationStatus: 'declined' }))).toBe(true);
    expect(isResolvedElicitation(elicitation({ elicitationStatus: 'cancelled' }))).toBe(true);
    expect(isResolvedElicitation(elicitation({ elicitationStatus: 'pending' }))).toBe(false);
    expect(isResolvedElicitation(elicitation({ elicitationStatus: 'failed' }))).toBe(false);
  });
});

describe('groupElicitationMessages', () => {
  it('连续已解决且同标题的记录合并为一组', () => {
    const groups = groupElicitationMessages([
      elicitation({ id: 'm1', text: '问题 1' }),
      elicitation({ id: 'm2', text: '问题 2' }),
      elicitation({ id: 'm3', text: '问题 3' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((message) => message.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('中间插入未解决记录时断开分组', () => {
    const groups = groupElicitationMessages([
      elicitation({ id: 'm1' }),
      elicitation({ id: 'm2', elicitationStatus: 'pending' }),
      elicitation({ id: 'm3' }),
    ]);
    expect(groups).toHaveLength(3);
  });

  it('标题不同（问答记录与确认记录）时断开分组', () => {
    const groups = groupElicitationMessages([
      elicitation({ id: 'm1' }),
      elicitation({ id: 'm2', elicitationKind: undefined }),
      elicitation({ id: 'm3' }),
    ]);
    expect(groups).toHaveLength(3);
  });

  it('单条记录保持独立组', () => {
    expect(groupElicitationMessages([elicitation({ id: 'm1' })])).toHaveLength(1);
    expect(groupElicitationMessages([])).toHaveLength(0);
  });
});
