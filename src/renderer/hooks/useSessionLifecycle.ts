/**
 * useSessionLifecycle — Session 生命周期管理。
 *
 * 处理会话的创建、选择、同步、关闭、Fork 全生命周期：
 * - handleNewSession / handleSelectProjectSession / syncProjectSessions
 * - handleCloseSession / handleForkSession
 * - 自动同步 useEffect：选中的项目变化时拉取 session 列表
 * - session/load 历史回放逻辑
 *
 * ## 关键不变量（AGENTS.md）
 * 三处 cwd 校验必须一致，否则切换项目后指令可能误跑在旧目录：
 * 1. handleUseProject / handleSelectWorkspace → stopSessionProcess + 重置 selectedSession
 * 2. sendContent → 校验 session.projectPath === selectedProject.path
 * 3. agentService.sendAgentMessage → 检测 cwd 变化时重启进程
 *
 * ## 维护
 * - Fork 跨项目时需要先切目录再建占位会话，顺序不可颠倒。
 * - replay 完成后自动触发 config 恢复（model/mode/thinking）。
 */
import { useEffect } from 'react';
import { DEFAULT_APPROVAL_PROFILE } from '../lib/constants';
import { useAppCore } from './useAppCore';
import { useProjectActions } from './useProjectActions';
import { useToolGroups } from './useToolGroups';

export function useSessionLifecycle(
  app: ReturnType<typeof useAppCore>,
  toolGroups: ReturnType<typeof useToolGroups>,
  projectActions: Pick<ReturnType<typeof useProjectActions>, 'handleUseProject'>,
) {
  useEffect(() => {
    const project = app.selectedProject;
    const session = app.selectedSession;
    let active = true;
    if (!project || !session) {
      app.setAcpConfigOptions([]);
      return () => {
        active = false;
      };
    }

    const loadAgentConfig = async () => {
      const result = await window.ohMyPiDesktop.getAgentConfig(session.id, project.path);
      if (active && result.ok) {
        app.setAcpConfigOptions(result.configOptions ?? []);
      }
    };

    void loadAgentConfig();
    return () => {
      active = false;
    };
  }, [app.selectedProject, app.selectedSession]);

  // 打开项目时自动以 omp 的 session/list 为准重建左栏会话列表（去重 + 清理幽灵），与 /resume 对齐。
  useEffect(() => {
    const project = app.selectedProject;
    if (!project) {
      return;
    }
    let active = true;
    void (async () => {
      const result = await window.ohMyPiDesktop.syncSessions(
        project.path,
        app.selectedSessionRef.current?.id
      );
      if (active && result.ok && result.state) {
        app.setDesktopState(result.state);
      }
    })();
    return () => {
      active = false;
    };
  }, [app.selectedProject?.path]);

  useEffect(() => {
    const project = app.selectedProject;
    if (!project || app.selectedSession) {
      return;
    }
    const latestSession = app.desktopState.recentSessions.find(
      (session) => session.projectPath === project.path && session.acpSessionId
    );
    if (!latestSession?.acpSessionId) {
      return;
    }
    const refreshKey = `${latestSession.id}:${latestSession.acpSessionId}:${latestSession.updatedAt}`;
    if (app.configRefreshByProject.current[project.path] === refreshKey) {
      return;
    }
    app.configRefreshByProject.current[project.path] = refreshKey;
    void refreshProjectConfigFromSession(latestSession);
  }, [app.desktopState.recentSessions, app.selectedProject, app.selectedSession]);



  const handleSelectSession = (session: StoredSession) => {
    app.selectSession(session);
    const cached = app.messageCache.current[session.id] ?? [];
    app.setMessages(cached);
    app.setIsAgentBusy(false);
    app.setAcpConfigOptions([]);
    app.setDraftConfigValues({});
    app.setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
    app.setApprovalProfileNotice('');
    app.setApprovalRestoreFailed(false);
    app.setAvailableCommands([]);
    app.setDiffText('');
    app.setDiffStatus('尚未读取 diff');
    app.setUsageText(app.usageBySession.current[session.id] ?? '');
    app.setPermissionRequest(app.permissionBySession.current[session.id]?.[0] ?? null);
    app.setElicitationRequest(app.elicitationBySession.current[session.id]?.[0] ?? null);
    app.setQuestionnaireRequest(app.questionnaireBySession.current[session.id]?.[0] ?? null);
    if (session.acpSessionId && cached.length === 0) {
      app.setLoadingHistorySessionId(session.id);
      void replayHistory(session);
    } else if (session.acpSessionId) {
      app.setLoadingHistorySessionId(null);
      app.setHistoryScrollResetToken((value) => value + 1);
      void resumeSessionForConfig(session);
    } else {
      app.setLoadingHistorySessionId(null);
    }
  };

  const handleSelectProjectSession = async (project: StoredProject, session: StoredSession) => {
    app.setExpandedProjectPaths((current) =>
      current.includes(project.path) ? current : [...current, project.path]
    );
    if (app.selectedProject?.path !== project.path) {
      // 切换执行目录前先停掉旧 session 子进程，并刷新 lastOpenedAt（不重排项目顺序）。
      await projectActions.handleUseProject(project);
      await window.ohMyPiDesktop.touchProjectLastOpened(project.path);
    }
    handleSelectSession(session);
  };

  const syncProjectSessions = async (workspacePath: string) => {
    app.setAgentStatus('同步历史会话中');
    const result = await window.ohMyPiDesktop.syncSessions(workspacePath, app.selectedSessionRef.current?.id);
    if (!result.ok) {
      app.setAgentStatus(result.message ?? '同步失败');
      return;
    }
    if (result.state) {
      app.setDesktopState(result.state);
    }
    const count = result.state?.recentSessions.filter((session) => session.projectPath === workspacePath).length ?? 0;
    app.setAgentStatus(`已同步 ${count} 个会话`);
  };

  const replayHistory = async (session: StoredSession) => {
    if (!session.acpSessionId) {
      return;
    }
    app.setAgentStatus('加载历史中');
    const result = await window.ohMyPiDesktop.loadSession(
      session.id,
      session.projectPath,
      session.acpSessionId
    );
    if (!result.ok) {
      app.setLoadingHistorySessionId((current) => (current === session.id ? null : current));
      if (app.selectedSessionRef.current?.id === session.id) {
        app.setAgentStatus(result.message ?? '加载历史失败');
      }
    }
    await app.reloadState(session.projectPath);
  };

  const resumeSessionForConfig = async (session: StoredSession) => {
    if (!session.acpSessionId) {
      return;
    }
    const result = await window.ohMyPiDesktop.resumeSession(
      session.id,
      session.projectPath,
      session.acpSessionId
    );
    if (!result.ok) {
      app.setAgentStatus(result.message ?? '恢复配置失败');
    }
  };

  const refreshProjectConfigFromSession = async (session: StoredSession) => {
    if (!session.acpSessionId) {
      return;
    }
    const result = await window.ohMyPiDesktop.refreshSessionConfig(
      session.id,
      session.projectPath,
      session.acpSessionId
    );
    const configOptions = result.configOptions ?? [];
    if (!result.ok || configOptions.length === 0) {
      return;
    }
    app.setDesktopState((current) => ({
      ...current,
      configCacheByProjectPath: {
        ...current.configCacheByProjectPath,
        [session.projectPath]: {
          configOptions,
          availableCommands: current.configCacheByProjectPath[session.projectPath]?.availableCommands ?? [],
          updatedAt: new Date().toISOString()
        }
      }
    }));
  };

  const handleCloseSession = async (session: StoredSession) => {
    const isCurrent = app.selectedSessionRef.current?.id === session.id;
    const result = await window.ohMyPiDesktop.closeSession(session.id);
    app.setAgentStatus(result.ok ? 'session 已关闭' : result.message ?? '关闭失败');
    if (!result.ok) {
      return;
    }
    // 关闭时同步清掉对应 session 的 pending 卡片（即便 omp 不再回 done/error 也不会残留）。
    app.pendingSlashCommandBySession.current[session.id] = null;
    if (isCurrent) {
      app.bumpPendingSlashCommand();
    }
    // 关闭会话：清掉折叠桶，避免重新打开该会话看到旧折叠态残留。
    toolGroups.resetCollapsedToolGroupsForSession(session.id);
    app.clearApprovalStateForSession(session.id, { alsoClearActive: isCurrent });
    if (isCurrent) {
      app.selectSession(null);
      app.setMessages([]);
      app.setLoadingHistorySessionId(null);
      app.setIsAgentBusy(false);
      app.setAcpConfigOptions([]);
      app.setDraftConfigValues({});
      app.setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
      app.setApprovalProfileNotice('');
      app.setApprovalRestoreFailed(false);
      app.setAvailableCommands([]);
      app.setDiffText('');
      app.setDiffStatus('尚未读取 diff');
      app.setUsageText('');
    }
  };

  const handleForkSession = async (project: StoredProject, session: StoredSession) => {
    if (!session.acpSessionId) {
      app.setAgentStatus('该会话尚未关联到远端 acpSessionId，无法 Fork');
      return;
    }
    // 快照操作前的项目与会话：fork 失败时用于回滚到原上下文，避免停留在占位会话上。
    const previousProject = app.selectedProjectRef.current;
    const previousSession = app.selectedSessionRef.current;
    // 跨项目 fork：停掉旧 session 子进程（cwd 防御），切到目标项目。
    // 不走 projectActions.handleUseProject——它会 app.selectSession(null) 并清空中间栏，而下面要立即 app.selectSession(forked)。
    if (app.selectedProjectRef.current?.path !== project.path) {
      const previousSessionId = app.selectedSessionRef.current?.id;
      if (previousSessionId) {
        await window.ohMyPiDesktop.stopSessionProcess(previousSessionId);
        app.clearApprovalStateForSession(previousSessionId, { alsoClearActive: true });
      }
      app.selectProject(project);
      const status = await window.ohMyPiDesktop.checkOmp(project.path);
      app.setOmpStatus(status.installed ? status.message : '未安装 omp');
    }
    const newLocalId = `fork-${Date.now()}`;
    const sourceAcpSessionId = session.acpSessionId;
    // 先在本地切到 fork 占位会话（acpSessionId 待 fork 完成回填）。
    const forked: StoredSession = {
      id: newLocalId,
      projectPath: project.path,
      title: `${session.title} (fork)`,
      approvalProfile: session.approvalProfile ?? DEFAULT_APPROVAL_PROFILE,
      updatedAt: new Date().toISOString()
    };
    app.messageCache.current[newLocalId] = [];
    app.permissionBySession.current[newLocalId] = [];
    app.elicitationBySession.current[newLocalId] = [];
    app.questionnaireBySession.current[newLocalId] = [];
    app.usageBySession.current[newLocalId] = '';
    toolGroups.initBucket(newLocalId);
    app.selectSession(forked);
    app.setMessages([]);
    app.setLoadingHistorySessionId(newLocalId);
    app.setAgentStatus('Fork 中，正在加载历史');
    app.setIsAgentBusy(false);
    app.setAcpConfigOptions([]);
    app.setDraftConfigValues({});
    app.setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
    app.setApprovalProfileNotice('');
    app.setApprovalRestoreFailed(false);
    app.setDiffText('');
    app.setDiffStatus('尚未读取 diff');
    app.setUsageText('');
    app.setPermissionRequest(null);
    app.setElicitationRequest(null);
    app.setQuestionnaireRequest(null);
    const result = await window.ohMyPiDesktop.forkSession(newLocalId, project.path, sourceAcpSessionId);
    if (!result.ok) {
      // fork 失败：清理占位会话的四个缓存条目，避免左栏残留幽灵会话与缓存泄漏。
      delete app.messageCache.current[newLocalId];
      app.clearApprovalStateForSession(newLocalId, { alsoClearActive: true });
      delete app.usageBySession.current[newLocalId];
      toolGroups.resetCollapsedToolGroupsForSession(newLocalId);
      // 兜底杀掉可能已 spawn 但 ACP 握手/fork 阶段失败的 agent 子进程（不存在则 no-op）。
      window.ohMyPiDesktop.stopSessionProcess(newLocalId);
      app.setLoadingHistorySessionId((current) => (current === newLocalId ? null : current));
      // 跨项目 fork 失败：回滚到原项目与会话，恢复消息/用量/权限/配置缓存。
      // 同项目 fork 失败：置空选中会话，清空中间栏，左栏不再并入占位行。
      if (previousProject && previousSession && previousProject.path !== project.path) {
        app.selectProject(previousProject);
        app.selectSession(previousSession);
        app.setMessages(app.messageCache.current[previousSession.id] ?? []);
        app.setUsageText(app.usageBySession.current[previousSession.id] ?? '');
        app.setPermissionRequest(app.permissionBySession.current[previousSession.id]?.[0] ?? null);
        app.setElicitationRequest(app.elicitationBySession.current[previousSession.id]?.[0] ?? null);
        app.setQuestionnaireRequest(app.questionnaireBySession.current[previousSession.id]?.[0] ?? null);
        // 还原原项目的 ACP 配置缓存，让顶栏选择器立即显示正确选项。
        app.setAcpConfigOptions(
          app.desktopState.configCacheByProjectPath[previousProject.path]?.configOptions ?? []
        );
        app.setDraftConfigValues({});
        app.setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
        app.setApprovalProfileNotice('');
        app.setApprovalRestoreFailed(false);
        app.setAvailableCommands([]);
      } else {
        app.selectSession(null);
        app.setMessages([]);
      }
      app.setAgentStatus(result.message ?? 'Fork 失败');
      return;
    }
    // 用 fork 回传的新 acpSessionId 补全占位会话，便于后续读取配置 / 再次 fork。
    const newAcpSessionId = result.sessionId;
    if (newAcpSessionId) {
      app.updateSelectedSession((current) =>
        current && current.id === newLocalId ? { ...current, acpSessionId: newAcpSessionId } : current
      );
    }
    app.setAgentStatus('已 Fork');
    await app.reloadState(project.path);
  };

  const handleNewSession = async (project = app.selectedProject) => {
    if (!project) {
      return;
    }
    if (app.selectedProject?.path !== project.path) {
      await projectActions.handleUseProject(project);
      await window.ohMyPiDesktop.touchProjectLastOpened(project.path);
    }
    app.setExpandedProjectPaths((current) =>
      current.includes(project.path) ? current : [...current, project.path]
    );
    // 顶部「新建会话」只进入空白会话界面；真正的本地 session 在首次发送消息时延迟创建。
    // 清理上一个 session 的折叠桶，避免重新进入历史 session 时看到旧折叠态残留。
    toolGroups.resetCollapsedToolGroupsForSession(app.selectedSessionRef.current?.id);
    app.selectSession(null);
    app.setMessages([]);
    app.setLoadingHistorySessionId(null);
    app.setAgentStatus('空闲');
    app.setIsAgentBusy(false);
    app.setAcpConfigOptions([]);
    app.setDraftConfigValues({});
    app.setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
    app.setApprovalProfileNotice('');
    app.setApprovalRestoreFailed(false);
    app.setAvailableCommands([]);
    app.setDiffText('');
    app.setDiffStatus('尚未读取 diff');
    app.setUsageText('');
    app.setPermissionRequest(null);
    app.setElicitationRequest(null);
    app.setQuestionnaireRequest(null);
  };

  return {
    handleSelectSession,
    handleSelectProjectSession,
    handleNewSession,
    handleCloseSession,
    handleForkSession,
    replayHistory,
    resumeSessionForConfig,
    syncProjectSessions,
    refreshProjectConfigFromSession,
  };
}
