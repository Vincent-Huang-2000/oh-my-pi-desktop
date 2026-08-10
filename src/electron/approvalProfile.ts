/**
 * approvalProfile — 审批档位切换的纯决策函数。
 *
 * 无闭包依赖，可被 agentService.ts 调用，也可被单元测试独立覆盖。
 */
import type { ApprovalProfile, StoredSession } from './types.js';
import type { AcpProcessState } from './agentTypes.js';

// ── 决策结果 ──

export type ApprovalProfileAction =
  { kind: 'noop' } | { kind: 'defer'; approvalProfile: ApprovalProfile };

// ── 纯决策函数 ──

/**
 * 判定 `updateApprovalProfile` 应执行哪种操作：
 * - acpSessionId 为空或进程不存在/已关闭 → noop（无法切换）
 * - 进程存在且未关闭 → defer（暂存目标档位，待下一次 sendAgentMessage 前重建）
 */
export const decideApprovalProfileAction = (
  storedSession: StoredSession | undefined,
  processState: AcpProcessState | undefined,
): ApprovalProfileAction => {
  if (!storedSession?.acpSessionId) return { kind: 'noop' };
  if (!processState || processState.closed) return { kind: 'noop' };
  return { kind: 'defer', approvalProfile: storedSession.approvalProfile ?? 'write' };
};

/**
 * 读取 processState 上的 pendingApprovalProfile。
 */
export const getPendingApprovalProfile = (
  processState: AcpProcessState,
): ApprovalProfile | undefined => processState.pendingApprovalProfile;

// ── 泛化判定辅助 ──

/**
 * 泛化的 pending 检查：Map 中是否有任一条目引用目标进程。
 * 同时服务于 permissions 和 elicitations 两项判定。
 */
export const hasPendingForProcess = (
  pendingMap: Map<string, { process: AcpProcessState }>,
  process: AcpProcessState,
): boolean => Array.from(pendingMap.values()).some((p) => p.process === process);

/**
 * 判定进程是否空闲：无活跃回合、无待审 permission、无待审 elicitation、无待发问卷续发。
 */
export const isProcessIdle = (
  process: AcpProcessState,
  pendingPermissions: Map<string, { process: AcpProcessState }>,
  pendingElicitations: Map<string, { process: AcpProcessState }>,
): boolean =>
  process.turnInFlightCount === 0 &&
  !hasPendingForProcess(pendingPermissions, process) &&
  !hasPendingForProcess(pendingElicitations, process) &&
  process.questionnaireFollowUps.length === 0;
