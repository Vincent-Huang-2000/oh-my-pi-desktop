import { describe, expect, it } from 'vitest';
import type { AcpConfigOption } from '../types';
import { describeRunModeCapabilities, GUIDED_GOAL_VALUE } from './runModeCapabilities';

const modeConfig: AcpConfigOption = {
  id: 'mode',
  name: '模式',
  type: 'select',
  currentValue: 'default',
  options: [
    { value: 'default', name: 'Default' },
    { value: 'plan', name: 'Plan' },
    { value: 'goal', name: 'Goal' },
    { value: 'vibe', name: 'Vibe' },
  ],
};

describe('运行模式能力提示', () => {
  it('未连接时即使缓存包含高级模式，也只显示待检测并禁止选择', () => {
    const options = describeRunModeCapabilities(modeConfig, undefined);
    expect(options.slice(0, 2).every((option) => !option.disabledReason)).toBe(true);
    expect(options.slice(2).every((option) => Boolean(option.disabledReason))).toBe(true);
    expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
  });

  it('旧版完成能力下发后保留三个置灰入口', () => {
    const options = describeRunModeCapabilities(
      { ...modeConfig, options: modeConfig.options!.slice(0, 2) },
      { modes: ['default', 'plan'], commands: [] },
    );
    expect(options.slice(2).map((option) => option.value)).toEqual([
      'goal',
      GUIDED_GOAL_VALUE,
      'vibe',
    ]);
    expect(options.slice(2).every((option) => Boolean(option.disabledReason))).toBe(true);
  });

  it('按实际能力分别启用，而不是要求特定版本或同时支持全部功能', () => {
    const options = describeRunModeCapabilities(modeConfig, {
      modes: ['default', 'plan', 'goal'],
      commands: ['guided-goal'],
    });
    expect(options.find((option) => option.value === 'goal')?.disabledReason).toBeUndefined();
    expect(
      options.find((option) => option.value === GUIDED_GOAL_VALUE)?.disabledReason,
    ).toBeUndefined();
    expect(options.find((option) => option.value === 'vibe')?.disabledReason).toBeTruthy();
  });

  it('模式先到、命令还未到时，不把引导目标误判成不支持', () => {
    const options = describeRunModeCapabilities(modeConfig, { modes: ['default', 'goal', 'vibe'] });
    expect(options.find((o) => o.value === GUIDED_GOAL_VALUE)?.disabledReason).toContain(
      '尚未确认',
    );
  });

  it('全部支持时可正常选择', () => {
    const options = describeRunModeCapabilities(modeConfig, {
      modes: ['default', 'plan', 'goal', 'vibe'],
      commands: ['goal', 'guided-goal', 'vibe'],
    });
    expect(options.every((option) => !option.disabledReason)).toBe(true);
  });

  it('没有配置时仍展示高级入口，保持未加载文案由选择器处理', () => {
    expect(describeRunModeCapabilities(undefined, undefined)).toHaveLength(3);
  });
});
