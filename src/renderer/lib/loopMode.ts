/**
 * loopMode — Loop 运行模式的纯逻辑：参数解析、额度计算、触发判定与展示文案。
 *
 * omp 的 /loop 只在 TUI 实现（ACP 下没有 handle），桌面端在渲染进程自行驱动：
 * 每轮结束后由 useLoopMode 调用 planLoopFire 判定是否自动重发同一条提示。
 * 语义对齐 omp `modes/loop-limit.ts`：
 * - `/loop 10` = 首次发送 + 自动重复 10 次；时长限制从开启时刻起算。
 * - 暂不支持 `--while` / `--until` 条件循环。
 *
 * ## 维护
 * - 本文件不依赖 React，便于单元测试（loopMode.test.ts）。
 * - tsconfig target 为 ES2020，不使用 replaceAll / at 等更新的 API。
 */

// 每轮结束后等待一小段时间再重发，给用户留出点击停止的窗口（与 omp TUI 一致）。
export const LOOP_FIRE_DELAY_MS = 800;
export const LOOP_ICON = '🔁';

// /loop 参数或弹层表单解析出的限制（尚未运行）。
export type LoopLimitSpec =
  { kind: 'iterations'; count: number } | { kind: 'duration'; durationMs: number };

// 运行态限制：次数记录初始值与剩余值；时长在开启时换算为绝对截止时间。
export type LoopLimit =
  | { kind: 'iterations'; initial: number; remaining: number }
  | { kind: 'duration'; durationMs: number; deadlineMs: number };

// 单个 session 的 Loop 状态；存在即表示已开启，关闭时整体删除。
export type LoopState = {
  // 每轮重复的提示；null 表示等待下一条消息（刚开启或暂停后）。
  prompt: string | null;
  // null 表示不限次数。
  limit: LoopLimit | null;
  // 区分「已暂停」与「等待下一条消息」两种展示。
  paused: boolean;
  // 开启时的执行目录，自动发送前校验 cwd 不变量。
  projectPath: string;
  // 已自动重复的次数，仅用于展示。
  iteration: number;
  enabledAt: number;
};

export type LoopParseResult =
  { ok: true; limit: LoopLimitSpec | null; prompt: string } | { ok: false; error: string };

export type LoopLimitKind = 'none' | 'iterations' | 'duration';
export type LoopDurationUnit = 'minutes' | 'hours';

export type LoopFireContext = {
  nowMs: number;
  // 该 session 仍有未结算的 prompt。
  busy: boolean;
  // Loop 所属执行目录与当前选中项目一致。
  workspaceMatches: boolean;
  // 有待处理的审批或方案审核，需要用户先行处理。
  awaitingUser: boolean;
};

export type LoopFireDecision =
  | { action: 'skip' }
  | { action: 'pause'; notice: string }
  | { action: 'disable'; notice: string }
  | { action: 'fire'; next: LoopState; prompt: string; statusText: string };

export type LoopSettleOutcome = 'completed' | 'cancelled' | 'error';

const LOOP_USAGE =
  '用法：/loop [次数|时长] [提示词]，例如 /loop 10、/loop 30m、/loop 1h30m 修复失败的测试。';

const TIME_UNITS_MS = new Map<string, number>([
  ['s', 1_000],
  ['sec', 1_000],
  ['secs', 1_000],
  ['second', 1_000],
  ['seconds', 1_000],
  ['m', 60_000],
  ['min', 60_000],
  ['mins', 60_000],
  ['minute', 60_000],
  ['minutes', 60_000],
  ['h', 3_600_000],
  ['hr', 3_600_000],
  ['hrs', 3_600_000],
  ['hour', 3_600_000],
  ['hours', 3_600_000],
]);

const toPositiveInteger = (text: string): number | null => {
  const amount = Number(text);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
};

// 解析 `10m`、`90s`、`1h30m` 这类紧凑/复合时长；不像时长时返回 undefined，单位或数值非法时返回错误文案。
const parseCompoundDuration = (token: string): LoopLimitSpec | string | undefined => {
  if (!/^(?:\d+[a-z]+)+$/.test(token)) return undefined;
  let totalMs = 0;
  for (const segment of token.match(/\d+[a-z]+/g) ?? []) {
    const match = /^(\d+)([a-z]+)$/.exec(segment);
    const unitMs = match ? TIME_UNITS_MS.get(match[2]) : undefined;
    if (!match || unitMs === undefined) return '时长单位只能是秒（s）、分钟（m）或小时（h）。';
    const amount = toPositiveInteger(match[1]);
    if (amount === null) return '循环时长必须大于 0。';
    totalMs += amount * unitMs;
  }
  return { kind: 'duration', durationMs: totalMs };
};

/**
 * 解析 `/loop` 参数：可选的前导限制（次数或时长）+ 可选的内联提示。
 * 前导 token 以数字或正负号开头却无法解析时报错，避免笔误被当成提示文本发出；
 * 其余普通文字整体作为提示（不限次数）。
 */
export function parseLoopArgs(args: string): LoopParseResult {
  const trimmed = args.trim();
  if (!trimmed) return { ok: true, limit: null, prompt: '' };

  let limit: LoopLimitSpec | null = null;
  let rest = trimmed;
  const firstSpace = trimmed.search(/\s/);
  const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const afterFirst = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
  const token = firstToken.toLowerCase();

  if (/^\d+$/.test(token)) {
    // 纯整数：后跟单位词（如 `10 minutes`）为时长，否则为重复次数。
    const unitToken = /^\S+/.exec(afterFirst)?.[0] ?? '';
    const unitMs = unitToken ? TIME_UNITS_MS.get(unitToken.toLowerCase()) : undefined;
    const amount = toPositiveInteger(token);
    if (amount === null) {
      return { ok: false, error: `${unitMs ? '循环时长' : '重复次数'}必须大于 0。${LOOP_USAGE}` };
    }
    if (unitMs !== undefined) {
      limit = { kind: 'duration', durationMs: amount * unitMs };
      rest = afterFirst.slice(unitToken.length).trim();
    } else {
      limit = { kind: 'iterations', count: amount };
      rest = afterFirst;
    }
  } else if (/^[+-]?\d/.test(token)) {
    const duration = parseCompoundDuration(token);
    if (typeof duration === 'string') return { ok: false, error: `${duration}${LOOP_USAGE}` };
    if (!duration) return { ok: false, error: `无法识别「${firstToken}」。${LOOP_USAGE}` };
    limit = duration;
    rest = afterFirst;
  }

  if (rest.startsWith('--')) {
    return { ok: false, error: `暂不支持 --while / --until 条件循环。${LOOP_USAGE}` };
  }
  return { ok: true, limit, prompt: rest };
}

// 弹层表单的限制校验，与 /loop 参数共用正整数规则。
export function buildLoopLimitSpec(
  kind: LoopLimitKind,
  value: string,
  unit: LoopDurationUnit,
): { ok: true; spec: LoopLimitSpec | null } | { ok: false; error: string } {
  if (kind === 'none') return { ok: true, spec: null };
  const amount = /^\d+$/.test(value.trim()) ? toPositiveInteger(value.trim()) : null;
  if (amount === null) {
    return { ok: false, error: kind === 'iterations' ? '重复次数须为正整数' : '时长须为正整数' };
  }
  if (kind === 'iterations') return { ok: true, spec: { kind, count: amount } };
  return {
    ok: true,
    spec: { kind: 'duration', durationMs: amount * (unit === 'hours' ? 3_600_000 : 60_000) },
  };
}

export function createLoopLimit(spec: LoopLimitSpec | null, nowMs: number): LoopLimit | null {
  if (!spec) return null;
  if (spec.kind === 'iterations') {
    return { kind: 'iterations', initial: spec.count, remaining: spec.count };
  }
  return { kind: 'duration', durationMs: spec.durationMs, deadlineMs: nowMs + spec.durationMs };
}

export function createLoopState(
  spec: LoopLimitSpec | null,
  projectPath: string,
  nowMs: number,
): LoopState {
  return {
    prompt: null,
    limit: createLoopLimit(spec, nowMs),
    paused: false,
    projectPath,
    iteration: 0,
    enabledAt: nowMs,
  };
}

// 有提示且未暂停：每轮结束后会自动重发。
export function isLoopRunning(loop: LoopState | null | undefined): loop is LoopState {
  return Boolean(loop && !loop.paused && loop.prompt);
}

// 消耗一次额度：次数类剩余减一；时长类只看截止时间，不变。
export function consumeLoopIteration(limit: LoopLimit | null): LoopLimit | null {
  if (limit?.kind !== 'iterations') return limit;
  return { ...limit, remaining: limit.remaining - 1 };
}

export function getLoopStopReason(
  limit: LoopLimit | null,
  nowMs: number,
): 'iterations' | 'duration' | null {
  if (!limit) return null;
  if (limit.kind === 'duration') return nowMs >= limit.deadlineMs ? 'duration' : null;
  return limit.remaining <= 0 ? 'iterations' : null;
}

/**
 * 判定一次自动重发的去向。判断顺序：
 * 未运行 → 跳过；执行目录不一致 → 关闭；仍忙 → 跳过（等下一次结算）；
 * 待用户处理 → 暂停；时长到期或次数用尽 → 关闭；否则消耗一次额度后发送。
 */
export function planLoopFire(
  loop: LoopState | null | undefined,
  context: LoopFireContext,
): LoopFireDecision {
  if (!loop || loop.paused || !loop.prompt) return { action: 'skip' };
  if (!context.workspaceMatches) {
    return { action: 'disable', notice: 'Loop 已关闭：执行目录已切换。' };
  }
  if (context.busy) return { action: 'skip' };
  if (context.awaitingUser) {
    return {
      action: 'pause',
      notice: 'Loop 已暂停：有待处理的审批或方案审核，处理后发送消息即可继续。',
    };
  }
  const stopReason = getLoopStopReason(loop.limit, context.nowMs);
  if (stopReason === 'duration') {
    return { action: 'disable', notice: 'Loop 已结束：已到达时长上限。' };
  }
  if (stopReason === 'iterations' && loop.limit?.kind === 'iterations') {
    return { action: 'disable', notice: `Loop 已结束：已完成 ${loop.limit.initial} 次重复。` };
  }
  const next: LoopState = {
    ...loop,
    limit: consumeLoopIteration(loop.limit),
    iteration: loop.iteration + 1,
  };
  return {
    action: 'fire',
    next,
    prompt: loop.prompt,
    statusText: formatLoopIterationStatus(next, context.nowMs),
  };
}

// 从 agent 事件判断一次 prompt 结算的结果；非结算事件返回 null。
export function getLoopSettleOutcome(event: AgentEvent): LoopSettleOutcome | null {
  if (event.type === 'error') return event.settlesPrompt ? 'error' : null;
  if (event.type !== 'done') return null;
  const payload = event.payload;
  const stopReason =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).stopReason
      : undefined;
  return stopReason === 'cancelled' ? 'cancelled' : 'completed';
}

const formatDuration = (durationMs: number): string => {
  const hours = Math.floor(durationMs / 3_600_000);
  const minutes = Math.floor((durationMs % 3_600_000) / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1_000);
  const parts = [
    hours > 0 ? `${hours} 小时` : '',
    minutes > 0 ? `${minutes} 分钟` : '',
    seconds > 0 ? `${seconds} 秒` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : '0 秒';
};

// 截止时刻：同一天显示 HH:mm，跨天加上 M月D日。手动拼接，不依赖系统 locale。
const formatDeadline = (deadlineMs: number, nowMs: number): string => {
  const deadline = new Date(deadlineMs);
  const now = new Date(nowMs);
  const clock = `${String(deadline.getHours()).padStart(2, '0')}:${String(
    deadline.getMinutes(),
  ).padStart(2, '0')}`;
  const sameDay =
    deadline.getFullYear() === now.getFullYear() &&
    deadline.getMonth() === now.getMonth() &&
    deadline.getDate() === now.getDate();
  return sameDay ? clock : `${deadline.getMonth() + 1}月${deadline.getDate()}日 ${clock}`;
};

export function describeLoopLimitSpec(spec: LoopLimitSpec | null): string {
  if (!spec) return '不限次数';
  if (spec.kind === 'iterations') return `重复 ${spec.count} 次`;
  return `持续 ${formatDuration(spec.durationMs)}`;
}

export function describeLoopRemaining(limit: LoopLimit | null, nowMs: number): string {
  if (!limit) return '不限次数';
  if (limit.kind === 'iterations') return `剩余 ${limit.remaining}/${limit.initial} 次`;
  return `截止 ${formatDeadline(limit.deadlineMs, nowMs)}`;
}

// 运行模式状态条的状态与补充说明。
export function describeLoopStatus(
  loop: LoopState,
  nowMs: number,
): { status: string; detail: string } {
  if (loop.paused) return { status: '已暂停', detail: '发送消息继续' };
  if (!loop.prompt) {
    const detail =
      loop.limit?.kind === 'iterations'
        ? `重复 ${loop.limit.remaining} 次`
        : describeLoopRemaining(loop.limit, nowMs);
    return { status: '等待下一条消息', detail };
  }
  return { status: '运行中', detail: describeLoopRemaining(loop.limit, nowMs) };
}

// 自动重发时写入消息流的状态行文案（图标由调用方统一添加）。
export function formatLoopIterationStatus(loop: LoopState, nowMs: number): string {
  if (loop.limit?.kind === 'iterations') {
    return `Loop 第 ${loop.iteration}/${loop.limit.initial} 次重复`;
  }
  if (loop.limit?.kind === 'duration') {
    return `Loop 第 ${loop.iteration} 次重复 · ${describeLoopRemaining(loop.limit, nowMs)}`;
  }
  return `Loop 第 ${loop.iteration} 次重复`;
}
