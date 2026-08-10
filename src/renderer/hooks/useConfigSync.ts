/**
 * useConfigSync — Agent 配置切换 hook。
 *
 * 处理四个 config 选项的切换逻辑：
 * - model / mode / thinking：无选中 session 时更新 draftConfigValues（占位草稿），
 *   有 session 时走 IPC setAgentConfigOption 实时生效。
 * - approvalProfile：暂存新档位并标记 pendingApprovalProfile；进程重建统一推迟到下次消息发送前执行。
 */
import { DEFAULT_APPROVAL_PROFILE } from '../lib/constants';
import type { useAppCore } from './useAppCore';
export function useConfigSync(app: ReturnType<typeof useAppCore>) {
  const handleModelChange = async (modelId: string) => {
    if (!app.selectedProject || !modelId) {
      return;
    }
    if (!app.selectedSession) {
      app.setDraftConfigValues((current) => ({ ...current, model: modelId }));
      return;
    }
    app.setAgentStatus('切换模型');
    const result = await window.ohMyPiDesktop.setAgentConfigOption(
      app.selectedSession.id,
      app.selectedProject.path,
      'model',
      modelId,
    );
    if (result.ok) {
      app.setAcpConfigOptions(result.configOptions ?? []);
      app.setAgentStatus('空闲');
    } else {
      app.setAgentStatus('错误');
    }
  };

  const handleModeChange = async (modeId: string) => {
    if (!app.selectedProject || !modeId) {
      return;
    }
    if (!app.selectedSession) {
      app.setDraftConfigValues((current) => ({ ...current, mode: modeId }));
      return;
    }
    app.setAgentStatus('切换模式');
    const result = await window.ohMyPiDesktop.setAgentConfigOption(
      app.selectedSession.id,
      app.selectedProject.path,
      'mode',
      modeId,
    );
    if (result.ok) {
      app.setAcpConfigOptions(result.configOptions ?? []);
      app.setAgentStatus('空闲');
    } else {
      app.setAgentStatus('错误');
    }
  };

  const handleThinkingChange = async (thinkingId: string) => {
    if (!app.selectedProject || !thinkingId) {
      return;
    }
    if (!app.selectedSession) {
      app.setDraftConfigValues((current) => ({ ...current, thinking: thinkingId }));
      return;
    }
    app.setAgentStatus('切换推理强度');
    const result = await window.ohMyPiDesktop.setAgentConfigOption(
      app.selectedSession.id,
      app.selectedProject.path,
      'thinking',
      thinkingId,
    );
    if (result.ok) {
      app.setAcpConfigOptions(result.configOptions ?? []);
      app.setAgentStatus('空闲');
    } else {
      app.setAgentStatus('错误');
    }
  };

  const handleApprovalProfileChange = async (approvalProfile: ApprovalProfile) => {
    if (!app.selectedProject) {
      return;
    }
    if (!app.selectedSession) {
      app.setDraftApprovalProfile(approvalProfile);
      app.setApprovalProfileNotice('');
      app.setApprovalRestoreFailed(false);
      return;
    }

    const existingProfile = app.selectedSession.approvalProfile ?? DEFAULT_APPROVAL_PROFILE;
    if (existingProfile === approvalProfile && !app.approvalRestoreFailed) {
      return;
    }

    const sessionId = app.selectedSession.id;
    const workspacePath = app.selectedProject.path;

    // 乐观更新本地状态，用户立即看到 UI 变化。
    app.updateSelectedSession((current) =>
      current?.id === sessionId ? { ...current, approvalProfile } : current,
    );
    app.setApprovalProfileNotice('');
    app.setAgentStatus('正在切换审批档位');

    const result = await window.ohMyPiDesktop
      .updateSessionApprovalProfile(sessionId, workspacePath, approvalProfile)
      .catch((error: unknown) => {
        console.error('updateSessionApprovalProfile failed:', error);
        return {
          ok: false,
          deferred: false,
          session: undefined,
          message: '审批档位切换失败，请重试',
        };
      });

    const updatedSession = result.session;
    if (updatedSession) {
      app.setDesktopState((current) => ({
        ...current,
        recentSessions: current.recentSessions.map((session) =>
          session.id === updatedSession.id ? updatedSession : session,
        ),
      }));
    }

    const isCurrentSession =
      app.selectedSession?.id === sessionId && app.selectedProject?.path === workspacePath;
    if (result.ok) {
      if (isCurrentSession) {
        app.setApprovalRestoreFailed(false);
        app.setAgentStatus('审批档位已保存');
      }
      return;
    }
    if (isCurrentSession) {
      app.setApprovalRestoreFailed(Boolean(result.session));
      app.setApprovalProfileNotice(result.message ?? '审批档位切换失败，请重试');
      app.setAgentStatus('审批档位切换失败');
    }
  };

  return { handleModelChange, handleModeChange, handleThinkingChange, handleApprovalProfileChange };
}
