/**
 * goalMode — Goal / Vibe 运行模式的展示逻辑（纯函数）。
 *
 * 与 Loop 不同，这两种模式由 omp acp 实现（omp.goalMode / omp.vibeMode v1）：
 * 目标的创建、续跑、暂停、完成都在 omp 中进行，经 goal_update 下发快照；
 * 桌面端只把快照转成运行模式状态条的文案、可用操作与切换模式前的警告。
 *
 * ## 维护
 * - 本文件不依赖 React，便于单元测试（goalMode.test.ts）。
 * - tsconfig target 为 ES2020，不使用 replaceAll / at 等更新的 API。
 */

export const GOAL_ICON = '🎯';
export const VIBE_ICON = '🌀';
// omp 下发的 mode 取值。
export const GOAL_MODE_ID = 'goal';
export const VIBE_MODE_ID = 'vibe';

// 状态条上的操作：guided = 引导设定、cancel = 取消待设定 / 引导、
// pause / resume = 暂停 / 继续目标、drop = 放弃目标。
export type GoalStripAction = 'guided' | 'cancel' | 'pause' | 'resume' | 'drop';

export type GoalStripView = {
  status: string;
  detail?: string;
  tone: 'active' | 'paused';
  actions: GoalStripAction[];
};

const OBJECTIVE_SUMMARY_LENGTH = 40;

// 目标可能是 guided goal 生成的 Markdown（以「## Objective」开头）：取第一行正文作为摘要。
export const summarizeObjective = (objective: string): string => {
  const lines = objective
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.find((candidate) => !candidate.startsWith('#')) ?? lines[0] ?? '';
  return line.length > OBJECTIVE_SUMMARY_LENGTH
    ? `${line.slice(0, OBJECTIVE_SUMMARY_LENGTH - 1)}…`
    : line;
};

const formatTokens = (value: number): string => {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
};

const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${Math.floor(seconds / 3600)} 小时${minutes > 0 ? ` ${minutes} 分钟` : ''}`;
};

// 已用 token（及预算）与耗时，如「12.3k / 50k tokens · 5 分钟」。
export const formatGoalUsage = (goal: GoalModeGoal): string => {
  const tokens =
    goal.tokenBudget !== undefined
      ? `${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)} tokens`
      : `${formatTokens(goal.tokensUsed)} tokens`;
  return `${tokens} · ${formatDuration(goal.timeUsedSeconds)}`;
};

// 状态条展示；返回 null 表示不显示（Goal 模式已结束）。
// 预算用尽时 omp 不会继续，需先用 /goal budget 调整预算，因此只提供放弃。
export const describeGoalStrip = (snapshot: GoalModeSnapshot): GoalStripView | null => {
  const goal = snapshot.goal;
  if (!goal) {
    if (snapshot.armed === 'interview') {
      return {
        status: '引导设定中',
        detail: '回答 agent 的问题，确认后自动开始',
        tone: 'active',
        actions: ['cancel'],
      };
    }
    if (snapshot.armed === 'objective') {
      return {
        status: '待设定',
        detail: '发送的下一条消息将作为目标',
        tone: 'active',
        actions: ['guided', 'cancel'],
      };
    }
    return null;
  }
  const detail = `${summarizeObjective(goal.objective)} · ${formatGoalUsage(goal)}`;
  switch (goal.status) {
    case 'active':
      return { status: '进行中', detail, tone: 'active', actions: ['pause', 'drop'] };
    case 'paused':
      return { status: '已暂停', detail, tone: 'paused', actions: ['resume', 'drop'] };
    case 'budget-limited':
      return { status: '预算已用尽', detail, tone: 'paused', actions: ['drop'] };
    case 'complete':
      return { status: '已完成', detail, tone: 'active', actions: [] };
    default:
      return null;
  }
};

// 从 Goal 切走（或点击放弃）前的警告：omp 的模式槽位只容纳一种模式，切走即放弃目标。
// 没有需要放弃的内容（未设定目标、目标已结束）时返回 null，直接切换。
export const getGoalExitWarning = (
  snapshot: GoalModeSnapshot | null | undefined,
): string | null => {
  const goal = snapshot?.goal;
  if (goal && goal.status !== 'complete' && goal.status !== 'dropped') {
    return `将放弃当前目标「${summarizeObjective(goal.objective)}」（已用 ${formatGoalUsage(goal)}），放弃后无法恢复。确定继续吗？`;
  }
  if (snapshot?.armed === 'interview') {
    return '将结束目标的引导设定，已回答的内容不会生成目标。确定继续吗？';
  }
  return null;
};
