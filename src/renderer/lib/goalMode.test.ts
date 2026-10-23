import { describe, expect, it } from 'vitest';
import { describeGoalStrip, getGoalExitWarning, summarizeObjective } from './goalMode';

const goal = (overrides: Partial<GoalModeGoal> = {}): GoalModeGoal => ({
  id: 'g1',
  objective: '修复登录流程',
  status: 'active',
  tokensUsed: 12_345,
  timeUsedSeconds: 300,
  ...overrides,
});

describe('Goal 状态条', () => {
  it('按目标状态给出不同的操作', () => {
    expect(describeGoalStrip({ goal: goal(), armed: null })?.actions).toEqual(['pause', 'drop']);
    expect(describeGoalStrip({ goal: goal({ status: 'paused' }), armed: null })).toMatchObject({
      tone: 'paused',
      actions: ['resume', 'drop'],
    });
    // 预算用尽时 omp 不会继续，不能提供「继续」。
    expect(
      describeGoalStrip({ goal: goal({ status: 'budget-limited' }), armed: null })?.actions,
    ).toEqual(['drop']);
  });

  it('待设定与引导设定阶段只提供对应入口，Goal 模式结束后不显示', () => {
    expect(describeGoalStrip({ goal: null, armed: 'objective' })?.actions).toEqual([
      'guided',
      'cancel',
    ]);
    expect(describeGoalStrip({ goal: null, armed: 'interview' })?.actions).toEqual(['cancel']);
    expect(describeGoalStrip({ goal: null, armed: null })).toBeNull();
  });

  it('摘要跳过 guided goal 生成的 Markdown 标题并截断过长目标', () => {
    expect(summarizeObjective('## Objective\nShip docs\n## Success criteria\n...')).toBe(
      'Ship docs',
    );
    expect(summarizeObjective('x'.repeat(60))).toHaveLength(40);
  });

  it('展示预算与耗时', () => {
    expect(describeGoalStrip({ goal: goal({ tokenBudget: 50_000 }), armed: null })?.detail).toBe(
      '修复登录流程 · 12k / 50k tokens · 5 分钟',
    );
  });
});

describe('切换模式前的警告', () => {
  it('存在未结束的目标或引导访谈时警告，否则直接切换', () => {
    expect(getGoalExitWarning({ goal: goal(), armed: null })).toContain('修复登录流程');
    expect(getGoalExitWarning({ goal: null, armed: 'interview' })).not.toBeNull();
    expect(getGoalExitWarning({ goal: null, armed: 'objective' })).toBeNull();
    expect(getGoalExitWarning({ goal: goal({ status: 'complete' }), armed: null })).toBeNull();
    expect(getGoalExitWarning(undefined)).toBeNull();
  });
});
