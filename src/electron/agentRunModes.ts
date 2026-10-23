/**
 * agentRunModes — omp 高级运行模式（omp.goalMode v1）的协议解析。
 *
 * 职责：
 * - 解析 `goal_update` session update 与会话响应 `_meta['omp.goalMode']` 中的目标快照
 *   （parseGoalModeSnapshot、getAcpGoalMode）。
 * - 生成写入事件 message 的简短中文描述（describeGoalModeSnapshot）。
 *
 * 旧版 omp 不下发这些字段：解析返回 null，桌面端不展示 Goal 状态，其余行为不变。
 * 协议说明见 omp fork 的 docs/acp-run-modes.md。
 */
import type { GoalModeGoal, GoalModeSnapshot } from './types.js';
import { isRecord } from './agentUtils.js';

const GOAL_STATUSES: ReadonlyArray<GoalModeGoal['status']> = [
  'active',
  'paused',
  'budget-limited',
  'complete',
  'dropped',
];

const parseGoalModeGoal = (value: unknown): GoalModeGoal | null => {
  if (!isRecord(value)) return null;
  const status = GOAL_STATUSES.find((candidate) => candidate === value.status);
  if (
    typeof value.id !== 'string' ||
    typeof value.objective !== 'string' ||
    !status ||
    typeof value.tokensUsed !== 'number' ||
    typeof value.timeUsedSeconds !== 'number'
  ) {
    return null;
  }
  return {
    id: value.id,
    objective: value.objective,
    status,
    // 未设预算时 omp 省略该字段。
    ...(typeof value.tokenBudget === 'number' ? { tokenBudget: value.tokenBudget } : {}),
    tokensUsed: value.tokensUsed,
    timeUsedSeconds: value.timeUsedSeconds,
  };
};

// `goal_update` 与 `omp.goalMode` 共用的快照字段：goal 为 null 表示没有目标；
// armed 表示已进入 Goal 模式但目标尚未设定。
export const parseGoalModeSnapshot = (value: unknown): GoalModeSnapshot | null => {
  if (!isRecord(value)) return null;
  const armed = value.armed === 'objective' || value.armed === 'interview' ? value.armed : null;
  if (value.goal === null || value.goal === undefined) return { goal: null, armed };
  const goal = parseGoalModeGoal(value.goal);
  return goal ? { goal, armed } : null;
};

// 会话响应（new/load/resume/fork）携带的目标快照；旧版 omp 没有该字段时返回 null。
export const getAcpGoalMode = (response: unknown): GoalModeSnapshot | null => {
  if (!isRecord(response) || !isRecord(response._meta)) return null;
  const meta = response._meta['omp.goalMode'];
  if (!isRecord(meta) || meta.version !== 1) return null;
  return parseGoalModeSnapshot(meta);
};

export const describeGoalModeSnapshot = (snapshot: GoalModeSnapshot): string => {
  if (snapshot.goal) return `目标状态：${snapshot.goal.status}`;
  if (snapshot.armed === 'interview') return '目标：引导设定中';
  if (snapshot.armed === 'objective') return '目标：等待设定';
  return '目标模式已结束';
};
