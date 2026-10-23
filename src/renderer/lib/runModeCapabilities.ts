import type { AcpConfigOption } from '../types';

// 来自启动探测或当前会话的实际能力；undefined 表示尚未确认，不能按不支持处理。
export type RunModeCapabilities = {
  modes?: string[];
  commands?: string[];
};

export type RunModeOption = NonNullable<AcpConfigOption['options']>[number] & {
  disabledReason?: string;
};

export const GUIDED_GOAL_VALUE = 'desktop:guided-goal';
const ADVANCED_MODES = [
  { value: 'goal', name: 'Goal', capability: 'modes', advertisedValue: 'goal' },
  {
    value: GUIDED_GOAL_VALUE,
    name: '引导目标',
    capability: 'commands',
    advertisedValue: 'guided-goal',
  },
  { value: 'vibe', name: 'Vibe', capability: 'modes', advertisedValue: 'vibe' },
] as const;

export function describeRunModeCapabilities(
  modeConfig: AcpConfigOption | undefined,
  capabilities: RunModeCapabilities | undefined,
) {
  const options: RunModeOption[] = (modeConfig?.options ?? []).filter(
    (option) => !ADVANCED_MODES.some((mode) => mode.value === option.value),
  );
  for (const mode of ADVANCED_MODES) {
    const advertised = capabilities?.[mode.capability];
    let disabledReason: string | undefined;
    if (!advertised) {
      disabledReason = '尚未确认当前 OMP 是否支持此功能';
    } else if (!advertised.includes(mode.advertisedValue)) {
      disabledReason = '当前 OMP 未提供此功能，请配置支持该功能的 OMP';
    }
    const actual = modeConfig?.options?.find((option) => option.value === mode.value);
    options.push({ value: mode.value, name: actual?.name ?? mode.name, disabledReason });
  }
  return options;
}
