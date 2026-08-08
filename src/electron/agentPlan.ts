/**
 * agentPlan — Plan 方案消息转换与磁盘文件操作。
 *
 * 职责：
 * - 将 ACP plan/plan_update 通知转换为面向用户的文本消息
 *   （getPlanMessage、getPlanUpdateMessage）。
 * - 定位并读取 ACP session 本地的 *-plan.md 方案文件
 *   （findSessionLocalDir、readPlanFile、readFullPlanForApproval）。
 * - 从重放历史中恢复已 resolve 的方案文件内容
 *   （readHistoricalSessionPlans、resolveHistoricalPlanPath）。
 * - 解析 omp.planMode 元数据以判断当前 Plan 是否激活
 *   （getAcpActivePlan）。
 *
 * 安全约束：通过 realpath + path.relative 防止符号链接逃逸；
 * 拒绝子目录、绝对路径与目录穿越；限制文件大小上限。
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { addLog } from './state.js';
import type { AgentEvent } from './types.js';
import type { AcpActivePlan, AcpProcessState, HistoricalSessionPlan } from './agentTypes.js';
import { MAX_PLAN_PREVIEW_BYTES } from './agentTypes.js';
import { isRecord } from './agentUtils.js';

// ── Plan 消息 ──

export const getPlanMessage = (update: Record<string, unknown>) => {
  const entries = Array.isArray(update.entries) ? update.entries : [];
  if (entries.length === 0) {
    return 'agent 清空了任务计划';
  }

  const statusMap: Record<string, string> = {
    pending: '待处理',
    in_progress: '进行中',
    completed: '已完成',
  };

  return entries
    .map((entry, index) => {
      if (!isRecord(entry)) {
        return `${index + 1}. 未知任务`;
      }
      const content = typeof entry.content === 'string' ? entry.content : '未知任务';
      const status =
        typeof entry.status === 'string' ? (statusMap[entry.status] ?? entry.status) : '未知状态';
      return `${index + 1}. [${status}] ${content}`;
    })
    .join('\n');
};

export const getPlanUpdateMessage = (update: Record<string, unknown>) => {
  if (!isRecord(update.plan)) {
    return 'agent 更新了任务计划';
  }
  if (update.plan.type === 'items') {
    return getPlanMessage(update.plan);
  }
  if (update.plan.type === 'markdown' && typeof update.plan.content === 'string') {
    return update.plan.content;
  }
  if (update.plan.type === 'file' && typeof update.plan.uri === 'string') {
    return `计划文件：${update.plan.uri}`;
  }
  return 'agent 更新了任务计划';
};

// ── Plan 文件操作 ──

export const findSessionLocalDir = async (process: AcpProcessState) => {
  const sessionId = process.localSessionId;
  const acpSessionId = process.acpSessionId ?? process.restoredAcpSessionId;
  if (!acpSessionId) {
    addLog(sessionId, 'info', `[plan-preview] acpSessionId 缺失，无法定位方案文件`);
    return null;
  }
  const agentDir =
    globalThis.process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), '.omp', 'agent');
  const sessionsRoot = path.join(agentDir, 'sessions');
  try {
    const projects = await readdir(sessionsRoot, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectRoot = path.join(sessionsRoot, project.name);
      const sessions = await readdir(projectRoot, { withFileTypes: true });
      const session = sessions.find(
        (entry) => entry.isDirectory() && entry.name.endsWith(`_${acpSessionId}`),
      );
      if (!session) continue;
      return path.join(projectRoot, session.name, 'local');
    }
    // 遍历完所有项目目录都没找到以 _<acpSessionId> 结尾的 session 目录。
    addLog(
      sessionId,
      'info',
      `[plan-preview] 未找到 session 目录（应 endsWith _${acpSessionId}），已扫描根：${sessionsRoot}`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    addLog(sessionId, 'info', `[plan-preview] 定位 session 目录抛异常：${reason}`);
  }
  return null;
};

export const getAcpActivePlan = (response: unknown): AcpActivePlan | null => {
  if (!isRecord(response) || !isRecord(response._meta)) return null;
  const planMode = response._meta['omp.planMode'];
  if (!isRecord(planMode) || planMode.version !== 1 || typeof planMode.active !== 'boolean') {
    return null;
  }
  if (!planMode.active) {
    return { version: 1, active: false };
  }
  if (
    typeof planMode.planFilePath !== 'string' ||
    (typeof planMode.content !== 'string' && planMode.content !== null)
  ) {
    return null;
  }
  return {
    version: 1,
    active: true,
    planFilePath: planMode.planFilePath,
    content: planMode.content,
  };
};

export const readPlanFile = async (
  process: AcpProcessState,
  localDir: string,
  filePath: string,
  logPrefix: 'plan-preview' | 'plan-history',
) => {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > MAX_PLAN_PREVIEW_BYTES) {
      if (fileStat.size > MAX_PLAN_PREVIEW_BYTES) {
        addLog(
          process.localSessionId,
          'info',
          `[${logPrefix}] 方案文件超 ${(MAX_PLAN_PREVIEW_BYTES / 1024 / 1024).toFixed(0)}MB 上限：${fileStat.size} 字节，${filePath}`,
        );
      }
      return null;
    }
    // realpath 同时防止历史 payload 通过符号链接逃逸到当前 ACP session 的 local 目录外。
    const [resolvedLocalDir, resolvedFilePath] = await Promise.all([
      realpath(localDir),
      realpath(filePath),
    ]);
    const relativePath = path.relative(resolvedLocalDir, resolvedFilePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null;
    }
    return await readFile(resolvedFilePath, 'utf8');
  } catch {
    return null;
  }
};

export const resolveHistoricalPlanPath = (localDir: string, planFilePath: string) => {
  if (!planFilePath.startsWith('local://')) {
    return null;
  }
  const fileName = planFilePath.slice('local://'.length);
  // OMP plan-mode 文件位于 local 根目录；拒绝子目录、绝对路径与目录穿越。
  if (!fileName || path.basename(fileName) !== fileName || !/(?:^|-)plan\.md$/i.test(fileName)) {
    return null;
  }
  return path.join(localDir, fileName);
};

// 实时审批没有通过协议携带精确 planFilePath，继续扫描当前 session 的 local 目录，
// 取 mtime 最新的 *-plan.md；历史恢复则走下方的精确路径读取，不使用这个降级。
export const readFullPlanForApproval = async (process: AcpProcessState) => {
  const localDir = await findSessionLocalDir(process);
  if (!localDir) return null;
  try {
    const localEntries = await readdir(localDir, { withFileTypes: true });
    const planFiles = localEntries.filter(
      (entry) => entry.isFile() && entry.name.endsWith('-plan.md'),
    );
    if (planFiles.length === 0) {
      // 无 *-plan.md 文件——可能不是 plan 审批（如普通工具审批），静默返回。
      return null;
    }
    // 取 mtime 最新的一个；并发写入时最新的即当前方案。
    let latest: { path: string; mtime: number; size: number } | null = null;
    for (const entry of planFiles) {
      const filePath = path.join(localDir, entry.name);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
      if (fileStat.mtimeMs > (latest?.mtime ?? -1)) {
        latest = { path: filePath, mtime: fileStat.mtimeMs, size: fileStat.size };
      }
    }
    if (!latest) {
      addLog(
        process.localSessionId,
        'info',
        `[plan-preview] local 下 *-plan.md 均非常规文件：${localDir}`,
      );
      return null;
    }
    const content = await readPlanFile(process, localDir, latest.path, 'plan-preview');
    if (content) {
      addLog(
        process.localSessionId,
        'info',
        `[plan-preview] 命中磁盘完整方案：${latest.path}（${latest.size} 字节）`,
      );
    }
    return content;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    addLog(process.localSessionId, 'info', `[plan-preview] 读取磁盘方案抛异常：${reason}`);
    return null;
  }
};

export const readHistoricalSessionPlans = async (
  process: AcpProcessState,
  replayEvents: AgentEvent[],
): Promise<HistoricalSessionPlan[]> => {
  const applyToolCallIds = new Set<string>();
  const referencedPlans = new Map<string, { toolCallId: string; planFilePath: string }>();
  for (const event of replayEvents) {
    if (event.type !== 'tool_call' || !isRecord(event.payload)) continue;
    const update = isRecord(event.payload.update) ? event.payload.update : undefined;
    if (!update || typeof update.toolCallId !== 'string') continue;
    if (
      update.title === 'resolve' &&
      isRecord(update.rawInput) &&
      update.rawInput.action === 'apply'
    ) {
      applyToolCallIds.add(update.toolCallId);
    }
    const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : undefined;
    const details = rawOutput && isRecord(rawOutput.details) ? rawOutput.details : undefined;
    const planFilePath = details?.planFilePath;
    if (
      !applyToolCallIds.has(update.toolCallId) ||
      details?.planExists !== true ||
      typeof planFilePath !== 'string'
    ) {
      continue;
    }
    // 同一路径可能经历多次"继续完善"；只保留最后一次 resolve apply 的最终文件内容。
    referencedPlans.delete(planFilePath);
    referencedPlans.set(planFilePath, { toolCallId: update.toolCallId, planFilePath });
  }
  if (referencedPlans.size === 0) return [];
  const localDir = await findSessionLocalDir(process);
  if (!localDir) return [];
  const plans: HistoricalSessionPlan[] = [];
  for (const reference of referencedPlans.values()) {
    const filePath = resolveHistoricalPlanPath(localDir, reference.planFilePath);
    if (!filePath) {
      addLog(
        process.localSessionId,
        'info',
        `[plan-history] 拒绝不安全或非 plan 路径：${reference.planFilePath}`,
      );
      continue;
    }
    const content = await readPlanFile(process, localDir, filePath, 'plan-history');
    if (!content) {
      addLog(
        process.localSessionId,
        'info',
        `[plan-history] 历史方案文件不存在或不可读：${reference.planFilePath}`,
      );
      continue;
    }
    plans.push({
      id: `history-plan-${reference.toolCallId}`,
      toolCallId: reference.toolCallId,
      planFilePath: reference.planFilePath,
      content,
    });
  }
  return plans;
};
