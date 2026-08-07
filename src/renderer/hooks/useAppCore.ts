/**
 * useAppCore — 渲染进程核心状态管理 hook。
 *
 * 集中持有 App.tsx 全部的 useState / useRef / useMemo / 核心动作，
 * 是所有业务 hook 的唯一状态来源。返回的 `app` 对象按 prop 传递，
 * 避免 Context 引入的渲染开销。
 *
 * ## 维护
 * - 新增 state 在函数体内按现有顺序追加，同步更新返回值结构。
 * - 所有 state 读写不走 reducer，保持直接 setter 访问——与旧版 App.tsx 一致。
 * - 类型定义跨进程同步：`src/electron/types.ts` ↔ `src/vite-env.d.ts`。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSearchItem } from '../components/SessionSearchModal';
import type { AcpConfigOption, ChatMessage, ElicitationRequest, PermissionRequest, QuestionnaireRequest } from '../types';
import type { PendingAttachment } from '../lib/attachments';
import { DEFAULT_APPROVAL_PROFILE, type DraftConfigValues, type ReviewSource } from '../lib/constants';
import type { PendingSlashCommand } from '../lib/slashCommands';
import type { GitBranchSwitchError } from '../components/GitBranchSwitchErrorModal';

export function useAppCore() {
  const [desktopState, setDesktopState] = useState<DesktopState>({
    recentProjects: [],
    recentSessions: [],
    logs: [],
    configCacheByProjectPath: {},
    toolModelSnapshotsBySession: {}
  });
  const [selectedProject, setSelectedProject] = useState<StoredProject | null>(null);
  const [selectedSession, setSelectedSession] = useState<StoredSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // 按 sessionId 缓存各会话的消息流，切换会话时恢复，避免回到已选过的会话时丢失历史。
  // 这是多 session 隔离的基石：每会话一份独立 ChatMessage 数组。
  const messageCache = useRef<Record<string, ChatMessage[]>>({});
  // 按 sessionId 缓存权限审批队列；同一回合可能并行发出多个请求，必须逐个响应，
  // 不能让后到请求覆盖先到请求，否则被覆盖的工具调用会被 omp 视为取消/拒绝。
  const permissionBySession = useRef<Record<string, PermissionRequest[]>>({});
  // 按 sessionId 缓存 elicitation 队列（omp 第2层审批门控），逻辑与权限队列对称。
  const elicitationBySession = useRef<Record<string, ElicitationRequest[]>>({});
  // 严格识别的 Plan 问卷独立排队，不能与普通 elicitation 的 Approve/Deny 混用。
  const questionnaireBySession = useRef<Record<string, QuestionnaireRequest[]>>({});
  const configRefreshByProject = useRef<Record<string, string>>({});
  // 按 sessionId 缓存当前模型快照（id+展示名）。tool_call 实时事件到达时从这里读，
  // 写入 ChatMessage.toolModel，作为「这次工具调用是哪个模型做的」的快照来源。
  // 来源：config_update 事件 / setAcpConfigOptions 路径，同步刷新（见下文同步逻辑）。
  const modelBySessionRef = useRef<Record<string, { id: string; name: string }>>({});

  // 将当前会话的最新消息同步进缓存；切走后再切回即可从缓存还原。
  useEffect(() => {
    if (selectedSession) {
      messageCache.current[selectedSession.id] = messages;
    }
  }, [messages, selectedSession]);

  // 始终指向当前选中会话，供 effect / 同步回调读取最新值而不必加额外依赖。
  const selectedSessionRef = useRef<StoredSession | null>(null);
  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);
  const selectedProjectRef = useRef<StoredProject | null>(null);
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);
  const selectProject = (project: StoredProject | null) => {
    // 像 selectedSessionRef 一样同步维护当前项目，避免异步 diff 请求落回旧项目。
    selectedProjectRef.current = project;
    setSelectedProject(project);
  };
  const selectSession = (session: StoredSession | null) => {
    // 事件可能在 React 完成下一次渲染前到达，先同步 ref，避免丢失当前会话的 ACP 配置事件。
    selectedSessionRef.current = session;
    setSelectedSession(session);
  };
  const updateSelectedSession = (updater: (current: StoredSession | null) => StoredSession | null) => {
    setSelectedSession((current) => {
      const next = updater(current);
      selectedSessionRef.current = next;
      return next;
    });
  };

  const [prompt, setPrompt] = useState('');
  // 待发送的 dataURL 图片块，列表为空时为纯文本发送。
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [ompStatus, setOmpStatus] = useState('未检测');
  // 用户指定的 omp 可执行文件路径；空字符串表示使用 PATH 中的 'omp'。
  const [ompPath, setOmpPath] = useState('');
  const [, setAgentStatus] = useState('空闲');
  const [isAgentBusy, setIsAgentBusy] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  // 项目展开态独立于选中态：允许多个项目同时展开，且点击项目不再改变最近项目排序。
  const [expandedProjectPaths, setExpandedProjectPaths] = useState<string[]>([]);
  const [acpConfigOptions, setAcpConfigOptions] = useState<AcpConfigOption[]>([]);
  // 草稿会话尚未创建真实 ACP session，用户在顶栏的选择先暂存，首次发送前再应用。
  const [draftConfigValues, setDraftConfigValues] = useState<DraftConfigValues>({});
  // 草稿会话尚无本地 sessionId，审批档位先随当前空白会话暂存，首次发送时一并持久化。
  const [draftApprovalProfile, setDraftApprovalProfile] = useState<ApprovalProfile>(
    DEFAULT_APPROVAL_PROFILE
  );
  // 审批运行环境恢复失败时在输入区展示可操作提示；详细原因只写主进程日志。
  const [approvalProfileNotice, setApprovalProfileNotice] = useState('');
  const [approvalRestoreFailed, setApprovalRestoreFailed] = useState(false);
  // ACP 通过 available_commands_update 维护的可用 slash 命令。
  const [availableCommands, setAvailableCommands] = useState<AcpAvailableCommand[]>([]);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  // 当前展示的 elicitation 弹窗（omp 第2层审批门控），与权限弹窗独立。
  const [elicitationRequest, setElicitationRequest] = useState<ElicitationRequest | null>(null);
  const [questionnaireRequest, setQuestionnaireRequest] = useState<QuestionnaireRequest | null>(null);
  // 三类审批共用同一右下角浮层位置；并发到达时按优先级互斥展示，
  // 避免完全重叠导致被遮挡的浮层无法点击。问卷最具体优先，permission 次之，
  // elicitation 最后。未入选的仍在各自队列中，当前浮层处理完后自动弹下一个。
  const activeApprovalKind: 'questionnaire' | 'permission' | 'elicitation' | null = questionnaireRequest
    ? 'questionnaire'
    : permissionRequest
      ? 'permission'
      : elicitationRequest
        ? 'elicitation'
        : null;
  // 只要主进程终止了某个 session 的 agent 进程，该 session 下三类待处理请求都会失效。
  // 统一清理三个队列，避免各生命周期路径手写时漏掉其中一类并恢复出失效弹窗。
  const clearApprovalStateForSession = (
    sessionId: string | undefined,
    { alsoClearActive = false }: { alsoClearActive?: boolean } = {}
  ) => {
    if (!sessionId) {
      return;
    }
    delete permissionBySession.current[sessionId];
    delete elicitationBySession.current[sessionId];
    delete questionnaireBySession.current[sessionId];
    if (alsoClearActive && selectedSessionRef.current?.id === sessionId) {
      setPermissionRequest(null);
      setElicitationRequest(null);
      setQuestionnaireRequest(null);
    }
  };
  const [diffText, setDiffText] = useState('');
  const [diffStatus, setDiffStatus] = useState('尚未读取未暂存改动');
  const [reviewSource, setReviewSource] = useState<ReviewSource>('unstaged');
  const reviewSourceRef = useRef<ReviewSource>('unstaged');
  const diffRefreshIdRef = useRef(0);
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  const [currentGitBranch, setCurrentGitBranch] = useState('');
  const [gitBranchNotice, setGitBranchNotice] = useState('');
  const [gitBranchSwitchError, setGitBranchSwitchError] = useState<GitBranchSwitchError | null>(null);
  const [switchingGitBranch, setSwitchingGitBranch] = useState(false);
  const branchRefreshIdRef = useRef(0);
  // 当前会话的上下文用量（v16.1.13 usage_update 事件）；按 sessionId 分桶，切会话时还原。
  const [, setUsageText] = useState('');
  // 按 sessionId 缓存用量文本，与 messageCache / permissionBySession 同属多 session 隔离缓存。
  const usageBySession = useRef<Record<string, string>>({});
  // 打开未缓存历史会话时显示加载态；history_loaded 到达后一次性替换为完整消息流。
  const [loadingHistorySessionId, setLoadingHistorySessionId] = useState<string | null>(null);
  // 历史消息渲染完成后让中间栏回到顶部，避免按实时流逻辑自动跟到底部。
  const [historyScrollResetToken, setHistoryScrollResetToken] = useState(0);
  // 待执行 slash 命令卡片：按 sessionId 分桶，切换 session 时只显示目标 session 的卡。
  // 配套 pendingSlashCommandVersion state 用于在 ref 写入后强制让 ChatWorkspace 重渲染读取最新值。
  const pendingSlashCommandBySession = useRef<Record<string, PendingSlashCommand | null>>({});
  const [pendingSlashCommandVersion, setPendingSlashCommandVersion] = useState(0);
  const bumpPendingSlashCommand = () => setPendingSlashCommandVersion((value) => value + 1);

  // 派生数据：按当前 project 过滤 session 列表 + 按当前 session 过滤最近日志 + 三个 config 控件。

  const sessionsForProject = useMemo(() => {
    if (!selectedProject) {
      return [];
    }
    const rows = desktopState.recentSessions.filter((session) => session.projectPath === selectedProject.path);
    // 把当前活动会话（可能是尚未同步进列表的新建/草稿）并入顶部，避免活动会话不在列表中。
    // 用 id 或 acpSessionId 判重，防止历史污染迁移期出现同一 omp 会话的双份行。
    if (
      selectedSession &&
      selectedSession.projectPath === selectedProject.path &&
      !rows.some(
        (session) =>
          session.id === selectedSession.id ||
          (!!selectedSession.acpSessionId && session.acpSessionId === selectedSession.acpSessionId)
      )
    ) {
      return [selectedSession, ...rows];
    }
    return rows;
  }, [desktopState.recentSessions, selectedProject, selectedSession]);
  // 派生数据：项目列表展示顺序。置顶项排在最前，其余保持持久化顺序不变。
  const displayedProjects = useMemo(() => {
    const rows = desktopState.recentProjects;
    const pinned = rows.filter((project) => project.pinned);
    const others = rows.filter((project) => !project.pinned);
    return pinned.length > 0 ? [...pinned, ...others] : rows;
  }, [desktopState.recentProjects]);

  const sessionSearchItems = useMemo<SessionSearchItem[]>(() => {
    const projectByPath = new Map(displayedProjects.map((project) => [project.path, project]));
    const rows = [...desktopState.recentSessions];
    if (
      selectedProject &&
      selectedSession &&
      !rows.some(
        (session) =>
          session.id === selectedSession.id ||
          (!!selectedSession.acpSessionId && session.acpSessionId === selectedSession.acpSessionId)
      )
    ) {
      rows.unshift(selectedSession);
    }

    return rows.flatMap((session) => {
      const project = projectByPath.get(session.projectPath);
      if (!project) {
        return [];
      }
      // 与 omp 的 session picker 保持方向一致：搜索用户 prompt，不把 assistant 回复和工具输出纳入搜索。
      const cachedMessages = selectedSession?.id === session.id
        ? messages
        : messageCache.current[session.id] ?? [];
      const promptText = cachedMessages
        .filter((message) => message.role === 'user')
        .map((message) => message.text)
        .join(' ');
      return [{
        project,
        session,
        promptText,
        isActive: selectedSession?.id === session.id
      }];
    });
  }, [desktopState.recentSessions, displayedProjects, messages, selectedProject, selectedSession]);

  const cachedProjectConfigOptions = useMemo(() => {
    if (!selectedProject) {
      return [];
    }
    return desktopState.configCacheByProjectPath[selectedProject.path]?.configOptions ?? [];
  }, [desktopState.configCacheByProjectPath, selectedProject]);

  // 全新项目还没有 ACP session，因而没有项目级配置缓存。此时只读复用最近一次
  // 有效配置供草稿选择；首次真实 session 返回 config_update 后仍由当前项目缓存接管。
  const latestCachedConfigOptions = useMemo(() => {
    const latestCache = Object.values(desktopState.configCacheByProjectPath)
      .filter((cache) => cache.configOptions.length > 0)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return latestCache?.configOptions ?? [];
  }, [desktopState.configCacheByProjectPath]);

  // 按项目缓存的命令列表：新 session 未连上 ACP 时复用，让输入 / 立刻有命令可选。
  const cachedProjectCommands = useMemo(() => {
    if (!selectedProject) {
      return [];
    }
    return desktopState.configCacheByProjectPath[selectedProject.path]?.availableCommands ?? [];
  }, [desktopState.configCacheByProjectPath, selectedProject]);

  // 当前展示的命令列表：优先用当前 session 的实时命令，未连上时回退到项目缓存。
  const displayedCommands = useMemo(
    () => (availableCommands.length > 0 ? availableCommands : cachedProjectCommands),
    [availableCommands, cachedProjectCommands],
  );

  const displayedConfigOptions = useMemo(() => {
    const draftConfigOptions = cachedProjectConfigOptions.length > 0
      ? cachedProjectConfigOptions
      : latestCachedConfigOptions;
    const source = selectedSession ? acpConfigOptions : draftConfigOptions;
    if (selectedSession) {
      return source;
    }
    return source.map((option) => {
      const draftValue = draftConfigValues[option.id as keyof DraftConfigValues];
      return draftValue ? { ...option, currentValue: draftValue } : option;
    });
  }, [
    acpConfigOptions,
    cachedProjectConfigOptions,
    draftConfigValues,
    latestCachedConfigOptions,
    selectedSession,
  ]);

  const modelConfig = useMemo(
    () => displayedConfigOptions.find((option) => option.id === 'model'),
    [displayedConfigOptions]
  );
  const modeConfig = useMemo(
    () => displayedConfigOptions.find((option) => option.id === 'mode'),
    [displayedConfigOptions]
  );
  const thinkingConfig = useMemo(
    () => displayedConfigOptions.find((option) => option.id === 'thinking'),
    [displayedConfigOptions]
  );
  const currentApprovalProfile = selectedSession?.approvalProfile ?? draftApprovalProfile;

  // 当前选中 session 的待执行 slash 命令：随 session 切换读对应 ref 桶，
  // pendingSlashCommandVersion 仅作依赖项用于触发重渲染（ref 写入不会触发渲染）。
  const pendingSlashCommand = useMemo<PendingSlashCommand | null>(() => {
    if (!selectedSession) {
      return null;
    }
    return pendingSlashCommandBySession.current[selectedSession.id] ?? null;
  }, [selectedSession, pendingSlashCommandVersion]);

  const reloadState = async (preferredProjectPath?: string) => {
    const state = await window.ohMyPiDesktop.getState();
    // 启动恢复场景（无 preferredProjectPath 且无当前 selectedProject）：
    // 按 lastOpenedAt 降序取最近操作过的项目作为「上次执行目录」，
    // 而非依赖 recentProjects 数组顺序（touchProjectLastOpened 不重排数组）。
    const lastOpenedProject =
      [...state.recentProjects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))[0] ?? null;
    const currentProjectPath = preferredProjectPath ?? selectedProject?.path ?? lastOpenedProject?.path;
    const currentProject =
      state.recentProjects.find((project) => project.path === currentProjectPath) ?? lastOpenedProject;
    setDesktopState(state);
    selectProject(preferredProjectPath
      ? currentProject ?? selectedProjectRef.current ?? null
      : selectedProjectRef.current ?? currentProject ?? null);
    // 方案 A（延迟创建会话）：进入执行目录后保持 selectedSession = null，
    // 中间栏显示新会话界面，用户首次发消息时才真正 createSession。
    // 因此这里不再自动选历史 session；用户点击左栏 session 才会选中。
    if (currentProjectPath) {
      updateSelectedSession((current) => (current && current.projectPath === currentProjectPath ? current : null));
    }
  };

  // 应用启动时恢复上次执行目录；若首次启动无任何项目，在用户文档目录下创建
  // omp-desktop 文件夹作为默认执行目录。selectedSession 保持 null 显示新会话界面（方案 A）。
  useEffect(() => {
    void (async () => {
      const state = await window.ohMyPiDesktop.getState();
      if (state.recentProjects.length === 0) {
        // 首次启动：创建默认目录并刷新 state。
        await window.ohMyPiDesktop.ensureDefaultWorkspace();
      }
      const savedOmpPath = await window.ohMyPiDesktop.getOmpPath();
      setOmpPath(savedOmpPath);
      await reloadState();
      // reloadState 已通过 selectProject 同步 selectedProjectRef，用其路径检测 OMP 状态，
      // 避免重启后 ompStatus 停留在初始值 '未检测'。
      const projectPath = selectedProjectRef.current?.path;
      if (projectPath) {
        const status = await window.ohMyPiDesktop.checkOmp(projectPath);
        setOmpStatus(status.installed ? status.message : '未安装 omp');
      }
    })();
  }, []);
  // 首次恢复默认项目时自动展开一次，之后由用户手动控制每个项目的展开/折叠。
  const didRestoreExpandedProject = useRef(false);
  useEffect(() => {
    if (didRestoreExpandedProject.current || !selectedProject) {
      return;
    }
    didRestoreExpandedProject.current = true;
    setExpandedProjectPaths([selectedProject.path]);
  }, [selectedProject]);

  return {
    desktopState,
    selectedProject,
    selectedSession,
    messages,
    prompt,
    pendingAttachments,
    ompStatus,
    ompPath,
    isAgentBusy,
    sessionSearchOpen,
    expandedProjectPaths,
    acpConfigOptions,
    draftConfigValues,
    draftApprovalProfile,
    approvalProfileNotice,
    approvalRestoreFailed,
    availableCommands,
    permissionRequest,
    elicitationRequest,
    questionnaireRequest,
    diffText,
    diffStatus,
    reviewSource,
    gitBranches,
    currentGitBranch,
    gitBranchNotice,
    gitBranchSwitchError,
    switchingGitBranch,
    loadingHistorySessionId,
    historyScrollResetToken,
    pendingSlashCommandVersion,
    setDesktopState,
    setSelectedProject,
    setSelectedSession,
    setMessages,
    setPrompt,
    setPendingAttachments,
    setOmpStatus,
    setOmpPath,
    setAgentStatus,
    setIsAgentBusy,
    setSessionSearchOpen,
    setExpandedProjectPaths,
    setAcpConfigOptions,
    setDraftConfigValues,
    setDraftApprovalProfile,
    setApprovalProfileNotice,
    setApprovalRestoreFailed,
    setAvailableCommands,
    setPermissionRequest,
    setElicitationRequest,
    setQuestionnaireRequest,
    setDiffText,
    setDiffStatus,
    setReviewSource,
    setGitBranches,
    setCurrentGitBranch,
    setGitBranchNotice,
    setGitBranchSwitchError,
    setSwitchingGitBranch,
    setUsageText,
    setLoadingHistorySessionId,
    setHistoryScrollResetToken,
    setPendingSlashCommandVersion,
    selectProject,
    selectSession,
    updateSelectedSession,
    messageCache,
    permissionBySession,
    elicitationBySession,
    questionnaireBySession,
    selectedSessionRef,
    selectedProjectRef,
    usageBySession,
    pendingSlashCommandBySession,
    modelBySessionRef,
    configRefreshByProject,
    reviewSourceRef,
    diffRefreshIdRef,
    branchRefreshIdRef,
    reloadState,
    clearApprovalStateForSession,
    bumpPendingSlashCommand,
    sessionsForProject,
    displayedProjects,
    sessionSearchItems,
    cachedProjectConfigOptions,
    latestCachedConfigOptions,
    cachedProjectCommands,
    displayedCommands,
    displayedConfigOptions,
    modelConfig,
    modeConfig,
    thinkingConfig,
    currentApprovalProfile,
    activeApprovalKind,
    pendingSlashCommand,
  };
}
