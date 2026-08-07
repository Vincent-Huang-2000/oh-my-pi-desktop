/**
 * useProjectActions — 项目栏操作 hook。
 *
 * 处理左侧 ProjectPane 的项目级操作：
 * - handleSelectWorkspace：停旧 agent 进程 → 选新目录 → 更新最近项目列表
 * - handleToggleProjectPinned / handleRevealProject / handleRenameProject / handleRemoveProject
 * - handleUseProject：内部方法，执行目录切换逻辑（停进程 + 选项目 + useWorkspace）
 *
 * ## 参数
 * @param app        useAppCore 返回的状态对象
 * @param toolGroups useToolGroups 返回的折叠管理方法（移除项目时需重置折叠）
 *
 * ## 维护
 * - handleUseProject 被 useSessionLifecycle 引用，export 签名不可随意变更。
 * - 切项目时必须先 stopSessionProcess 再 clear 相关状态，顺序不能颠倒。
 */
import { DEFAULT_APPROVAL_PROFILE } from '../lib/constants';
import { useAppCore } from './useAppCore';
import { useToolGroups } from './useToolGroups';

export function useProjectActions(
  app: ReturnType<typeof useAppCore>,
  toolGroups: ReturnType<typeof useToolGroups>,
) {
  const handleSelectWorkspace = async () => {
    const project = await window.ohMyPiDesktop.selectWorkspace();
    if (!project) {
      return;
    }

    // 与 handleUseProject 一致：切项目前先停掉旧 session 的子进程，防止 cwd 残留。
    const previousSessionId = app.selectedSessionRef.current?.id;
    if (previousSessionId) {
      await window.ohMyPiDesktop.stopSessionProcess(previousSessionId);
      app.clearApprovalStateForSession(previousSessionId, { alsoClearActive: true });
    }
    app.selectProject(project);
    // 切项目：清理旧 session 的折叠桶，切回时按需重建。
    toolGroups.resetCollapsedToolGroupsForSession(previousSessionId);
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
    app.setExpandedProjectPaths((current) =>
      current.includes(project.path) ? current : [...current, project.path]
    );
    const status = await window.ohMyPiDesktop.checkOmp(project.path);
    app.setOmpStatus(status.installed ? status.message : '未安装 omp');
    await app.reloadState(project.path);
  };

  const handleUseProject = async (project: StoredProject) => {
    // 先停掉旧 session 残留的子进程，避免它继续占用 cwd 或被后续 sendAgentMessage 复用。
    const previousSessionId = app.selectedSessionRef.current?.id;
    if (previousSessionId) {
      await window.ohMyPiDesktop.stopSessionProcess(previousSessionId);
      app.clearApprovalStateForSession(previousSessionId, { alsoClearActive: true });
    }
    app.selectProject(project);
    // 切项目：清理旧 session 的折叠桶。
    toolGroups.resetCollapsedToolGroupsForSession(previousSessionId);
    // 不再用闭包里的 app.desktopState 选旧 session：那份数据在 app.reloadState/syncSessions 完成前是陈旧的，
    // 可能选到不属于本项目的 session。统一置 null，由用户在左栏手动点开，或发消息时新建。
    app.selectSession(null);
    app.setMessages([]);
    app.setLoadingHistorySessionId(null);
    app.setIsAgentBusy(false);
    toolGroups.resetCollapsedToolGroupsForSession(previousSessionId);
    app.setDraftConfigValues({});
    app.setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
    app.setApprovalProfileNotice('');
    app.setApprovalRestoreFailed(false);
    app.setAvailableCommands([]);
    app.setDiffText('');
    app.setDiffStatus('尚未读取 diff');
    app.setUsageText('');
    const status = await window.ohMyPiDesktop.checkOmp(project.path);
    app.setOmpStatus(status.installed ? status.message : '未安装 omp');
    await app.reloadState(project.path);
  };

  const handleSelectOmpPath = async () => {
    if (app.isAgentBusy) {
      const confirmed = window.confirm('当前有正在运行的对话，切换 omp 会中断该对话，是否继续？');
      if (!confirmed) {
        return;
      }
    }
    const result = await window.ohMyPiDesktop.selectOmpPath();
    if (result.path !== undefined) {
      app.setOmpPath(result.path);
    }
    // 路径切换成功后，若当前有选中的 session，立即用新 omp 重启它。
    if (result.ok && app.selectedSession && app.selectedProject) {
      await window.ohMyPiDesktop.startAgent(app.selectedSession.id, app.selectedProject.path);
    }
    if (app.selectedProject) {
      const status = await window.ohMyPiDesktop.checkOmp(app.selectedProject.path);
      app.setOmpStatus(status.installed ? status.message : '未安装 omp');
    } else {
      app.setOmpStatus(result.ok ? (result.message || 'omp 已设置') : (result.message || 'omp 设置失败'));
    }
  };

  const toggleProjectExpanded = (projectPath: string) => {
    app.setExpandedProjectPaths((current) =>
      current.includes(projectPath)
        ? current.filter((path) => path !== projectPath)
        : [...current, projectPath]
    );
  };

  const handleToggleProjectPinned = async (project: StoredProject) => {
    const next = !project.pinned;
    const updated = await window.ohMyPiDesktop.setProjectPinned(project.path, next);
    if (!updated) {
      app.setAgentStatus('置顶失败：项目不存在');
      return;
    }
    app.setDesktopState((current) => ({
      ...current,
      recentProjects: current.recentProjects.map((item) => (item.path === updated.path ? updated : item))
    }));
    app.setAgentStatus(next ? `已置顶 ${updated.name}` : `已取消置顶 ${updated.name}`);
  };

  const handleRevealProject = async (project: StoredProject) => {
    const result = await window.ohMyPiDesktop.revealInExplorer(project.path);
    if (!result.ok) {
      app.setAgentStatus(result.message ? `打开目录失败：${result.message}` : '打开目录失败');
    }
  };

  const handleRenameProject = async (project: StoredProject, displayName: string) => {
    const updated = await window.ohMyPiDesktop.setProjectDisplayName(project.path, displayName);
    if (!updated) {
      app.setAgentStatus('重命名失败：项目不存在');
      return;
    }
    app.setDesktopState((current) => ({
      ...current,
      recentProjects: current.recentProjects.map((item) => (item.path === updated.path ? updated : item))
    }));
    app.setAgentStatus(`已重命名为 ${updated.displayName ?? updated.name}`);
  };

  const handleRemoveProject = async (project: StoredProject) => {
    // 移除前若该项目正在被作为执行目录使用，先停掉其下任意仍在跑的会话进程。
    // recentSessions 里属该 projectPath 的会话逐一 stopSessionProcess 兜底。
    const sessionsToRemove = app.desktopState.recentSessions.filter(
      (session) => session.projectPath === project.path
    );
    for (const session of sessionsToRemove) {
      await window.ohMyPiDesktop.stopSessionProcess(session.id);
    }
    const removed = await window.ohMyPiDesktop.removeProject(project.path);
    if (!removed) {
      app.setAgentStatus('移除失败：项目不存在');
      return;
    }
    for (const session of sessionsToRemove) {
      app.clearApprovalStateForSession(session.id, { alsoClearActive: true });
    }
    app.setDesktopState((current) => ({
      ...current,
      recentProjects: current.recentProjects.filter((item) => item.path !== project.path)
    }));
    // 若移除的是当前执行目录，清空选中态，并把当前会话相关的运行时缓存一并清空，
    // 让中间/右栏落到干净的空白态，避免「无目录 + 旧消息/用量/diff 残留」。
    if (app.selectedProjectRef.current?.path === project.path) {
      app.selectProject(null);
      // 清空当前展示的消息流及其按 sessionId 的缓存（你已确认清掉）。
      app.setMessages([]);
      for (const session of sessionsToRemove) {
        delete app.messageCache.current[session.id];
        delete app.usageBySession.current[session.id];
        toolGroups.resetCollapsedToolGroupsForSession(session.id);
        delete app.pendingSlashCommandBySession.current[session.id];
      }
      // 清掉当前展示的右栏运行时状态。
      app.setAgentStatus('');
      app.setUsageText('');
      app.setDiffText('');
      app.setDiffStatus('尚未读取 diff');
      app.setLoadingHistorySessionId(null);
      // 草稿配置按 sessionId 维护；清掉对应条目，避免下次同 id 会话复用残留草稿。
      app.setDraftConfigValues({});
      app.setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
      app.setApprovalProfileNotice('');
      app.setApprovalRestoreFailed(false);
      // 权限弹窗 / pending slash / 输入草稿：当前会话已不存在，全部置空。
      app.pendingSlashCommandBySession.current = {};
      app.setPendingSlashCommandVersion((v) => v + 1);
      app.setPrompt('');
      app.setPendingAttachments([]);
      app.setSelectedSession(null);
      app.selectedSessionRef.current = null;
    }
    app.setAgentStatus(`已移除 ${removed.name}`);
  };

  return {
    handleSelectWorkspace,
    handleUseProject,
    handleSelectOmpPath,
    toggleProjectExpanded,
    handleToggleProjectPinned,
    handleRevealProject,
    handleRenameProject,
    handleRemoveProject,
  };
}
