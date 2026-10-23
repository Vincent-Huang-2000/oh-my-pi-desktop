import { describe, expect, it } from 'vitest';
import {
  buildLoopLimitSpec,
  createLoopState,
  describeLoopRemaining,
  describeLoopStatus,
  getLoopSettleOutcome,
  parseLoopArgs,
  planLoopFire,
  type LoopFireContext,
  type LoopState,
} from './loopMode';

const idle: LoopFireContext = {
  nowMs: 0,
  busy: false,
  workspaceMatches: true,
  awaitingUser: false,
};

describe('/loop 参数解析', () => {
  it('解析次数、时长与内联提示，保留提示中的换行', () => {
    expect(parseLoopArgs('')).toEqual({ ok: true, limit: null, prompt: '' });
    expect(parseLoopArgs('10')).toEqual({
      ok: true,
      limit: { kind: 'iterations', count: 10 },
      prompt: '',
    });
    expect(parseLoopArgs('10 修复测试')).toEqual({
      ok: true,
      limit: { kind: 'iterations', count: 10 },
      prompt: '修复测试',
    });
    expect(parseLoopArgs('10 minutes 修复')).toEqual({
      ok: true,
      limit: { kind: 'duration', durationMs: 600_000 },
      prompt: '修复',
    });
    expect(parseLoopArgs('10 m')).toEqual({
      ok: true,
      limit: { kind: 'duration', durationMs: 600_000 },
      prompt: '',
    });
    expect(parseLoopArgs('90s')).toMatchObject({ limit: { durationMs: 90_000 } });
    expect(parseLoopArgs('1h30m 跑测试')).toEqual({
      ok: true,
      limit: { kind: 'duration', durationMs: 5_400_000 },
      prompt: '跑测试',
    });
    expect(parseLoopArgs('2hrs')).toMatchObject({ limit: { durationMs: 7_200_000 } });
    // 非数字开头的普通文字整体作为提示，不限次数。
    expect(parseLoopArgs('修复 测试')).toEqual({ ok: true, limit: null, prompt: '修复 测试' });
    expect(parseLoopArgs('3 行1\n行2')).toMatchObject({ prompt: '行1\n行2' });
  });

  it('形似限制但无法解析、或使用条件循环时报错', () => {
    for (const args of ['0', '1.5h', '-3', '+3', '10x', '0m']) {
      expect(parseLoopArgs(args).ok).toBe(false);
    }
    const condition = parseLoopArgs('--until "npm test" x');
    expect(condition.ok).toBe(false);
    expect(!condition.ok && condition.error).toContain('暂不支持');
    expect(parseLoopArgs('5 --while true x').ok).toBe(false);
  });

  it('弹层表单校验正整数并换算时长单位', () => {
    expect(buildLoopLimitSpec('none', '', 'minutes')).toEqual({ ok: true, spec: null });
    expect(buildLoopLimitSpec('iterations', '3', 'minutes')).toEqual({
      ok: true,
      spec: { kind: 'iterations', count: 3 },
    });
    expect(buildLoopLimitSpec('duration', '2', 'hours')).toEqual({
      ok: true,
      spec: { kind: 'duration', durationMs: 7_200_000 },
    });
    expect(buildLoopLimitSpec('iterations', '0', 'minutes').ok).toBe(false);
    expect(buildLoopLimitSpec('duration', '1.5', 'hours').ok).toBe(false);
  });
});

describe('Loop 自动重发判定', () => {
  it('/loop 2 = 首次发送 + 重复 2 次，之后自动关闭', () => {
    let loop: LoopState = {
      ...createLoopState({ kind: 'iterations', count: 2 }, 'D:/p', 0),
      prompt: 'say hi',
    };
    const first = planLoopFire(loop, idle);
    expect(first.action).toBe('fire');
    if (first.action !== 'fire') return;
    expect(first.prompt).toBe('say hi');
    expect(first.statusText).toContain('第 1/2 次重复');
    loop = first.next;
    const second = planLoopFire(loop, idle);
    expect(second.action).toBe('fire');
    if (second.action !== 'fire') return;
    expect(describeLoopRemaining(second.next.limit, 0)).toBe('剩余 0/2 次');
    const third = planLoopFire(second.next, idle);
    expect(third).toEqual({ action: 'disable', notice: 'Loop 已结束：已完成 2 次重复。' });
  });

  it('按顺序处理未运行、目录切换、忙碌、待处理与时长到期', () => {
    const base: LoopState = {
      ...createLoopState({ kind: 'duration', durationMs: 60_000 }, 'D:/p', 0),
      prompt: 'go',
    };
    expect(planLoopFire(null, idle)).toEqual({ action: 'skip' });
    expect(planLoopFire({ ...base, prompt: null }, idle)).toEqual({ action: 'skip' });
    expect(planLoopFire({ ...base, paused: true }, idle)).toEqual({ action: 'skip' });
    // 目录不一致优先于忙碌：进程即将被停止，不能继续等待。
    expect(planLoopFire(base, { ...idle, busy: true, workspaceMatches: false }).action).toBe(
      'disable',
    );
    expect(planLoopFire(base, { ...idle, busy: true, awaitingUser: true })).toEqual({
      action: 'skip',
    });
    expect(planLoopFire(base, { ...idle, awaitingUser: true }).action).toBe('pause');
    expect(planLoopFire(base, { ...idle, nowMs: 59_999 }).action).toBe('fire');
    expect(planLoopFire(base, { ...idle, nowMs: 60_000 })).toEqual({
      action: 'disable',
      notice: 'Loop 已结束：已到达时长上限。',
    });
  });

  it('区分完成、取消与出错的结算事件', () => {
    const event = (type: AgentEvent['type'], extra: Partial<AgentEvent> = {}): AgentEvent => ({
      sessionId: 's1',
      type,
      message: '',
      ...extra,
    });
    expect(getLoopSettleOutcome(event('done', { payload: { stopReason: 'end_turn' } }))).toBe(
      'completed',
    );
    expect(getLoopSettleOutcome(event('done'))).toBe('completed');
    expect(getLoopSettleOutcome(event('done', { payload: { stopReason: 'cancelled' } }))).toBe(
      'cancelled',
    );
    expect(getLoopSettleOutcome(event('error', { settlesPrompt: true }))).toBe('error');
    expect(getLoopSettleOutcome(event('error'))).toBeNull();
    expect(getLoopSettleOutcome(event('output'))).toBeNull();
  });
});

describe('Loop 展示文案', () => {
  it('截止时间同一天只显示时刻，跨天加日期', () => {
    const now = new Date(2026, 9, 23, 13, 0).getTime();
    const sameDay = new Date(2026, 9, 23, 14, 30).getTime();
    const nextDay = new Date(2026, 9, 24, 9, 5).getTime();
    expect(
      describeLoopRemaining({ kind: 'duration', durationMs: 0, deadlineMs: sameDay }, now),
    ).toBe('截止 14:30');
    expect(
      describeLoopRemaining({ kind: 'duration', durationMs: 0, deadlineMs: nextDay }, now),
    ).toBe('截止 10月24日 09:05');
  });

  it('状态条区分等待、运行与暂停', () => {
    const loop = createLoopState({ kind: 'iterations', count: 10 }, 'D:/p', 0);
    expect(describeLoopStatus(loop, 0)).toEqual({ status: '等待下一条消息', detail: '重复 10 次' });
    expect(describeLoopStatus({ ...loop, prompt: 'x' }, 0)).toEqual({
      status: '运行中',
      detail: '剩余 10/10 次',
    });
    expect(describeLoopStatus({ ...loop, paused: true }, 0).status).toBe('已暂停');
  });
});
