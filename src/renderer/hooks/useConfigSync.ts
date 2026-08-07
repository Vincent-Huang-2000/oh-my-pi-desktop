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
      modelId
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
      modeId
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
      thinkingId
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
    const willInterrupt = app.isAgentBusy || Boolean(app.permissionRequest) || Boolean(app.elicitationRequest) || Boolean(app.questionnaireRequest);
    const confirmed = window.confirm(
      willInterrupt
        ? '切换审批档位会取消当前回合，未完成的操作可能中断，并重启当前会话的 agent 运行环境。是否继续？'
        : '切换审批档位会重启当前会话的 agent 运行环境。是否继续？'
    );
    if (!confirmed) {
      return;
    }

    // 旧进程的审批请求即将失效，先清理当前会话的渲染缓存，避免留下可操作弹窗。
    app.clearApprovalStateForSession(app.selectedSession.id, { alsoClearActive: true });
    app.setIsAgentBusy(false);
    app.setAgentStatus('正在切换审批档位');
    app.setApprovalProfileNotice('');
    const result = await window.ohMyPiDesktop.updateSessionApprovalProfile(
      app.selectedSession.id,
      app.selectedProject.path,
      approvalProfile
    ).catch((error: unknown) => {
      console.error('updateSessionApprovalProfile failed:', error);
      return { ok: false, session: undefined, message: '审批档位切换失败，请重试' };
    });
    // IPC 完成后再清一次，覆盖取消与终止窗口内可能刚到达的旧 permission 事件。
    app.clearApprovalStateForSession(app.selectedSession.id, { alsoClearActive: true });

    const updatedSession = result.session;
    if (updatedSession) {
      app.setDesktopState((current) => ({
        ...current,
        recentSessions: current.recentSessions.map((session) =>
          session.id === updatedSession.id ? updatedSession : session
        )
      }));
      app.updateSelectedSession((current) =>
        current?.id === updatedSession.id ? updatedSession : current
      );
    }
    if (result.ok) {
      app.setApprovalRestoreFailed(false);
      app.setApprovalProfileNotice(result.message ?? '');
      app.setAgentStatus('审批档位已切换');
      return;
    }
    app.setApprovalRestoreFailed(Boolean(result.session));
    app.setApprovalProfileNotice(result.message ?? '审批档位切换失败，请重试');
    app.setAgentStatus('审批档位切换失败');
  };

  return { handleModelChange, handleModeChange, handleThinkingChange, handleApprovalProfileChange };
}
