/// <reference types="vite/client" />

type AgentPromptAttachment = {
  dataUrl: string;
  fileName?: string;
  kind: 'image' | 'text' | 'unsupported';
};

type AgentPromptContent = {
  text: string;
  attachments?: AgentPromptAttachment[];
};

type QuestionnaireAnswer = {
  questionIndex: number;
  selections: string[];
};

// 与主进程 agentService.ts 的 QuestionnaireResponseResult 保持一致。
type QuestionnaireResponseResult = {
  ok: boolean;
  message?: string;
  reason?: 'stale' | 'invalid-answers';
};

type StoredProject = {
  path: string;
  name: string;
  // 用户自定义显示名；为空时回退到 name（目录名）。
  displayName?: string;
  lastOpenedAt: string;
  pinned?: boolean;
};

type ApprovalProfile = 'always-ask' | 'write' | 'yolo';

type StoredSession = {
  id: string;
  projectPath: string;
  title: string;
  acpSessionId?: string;
  // 会话对应 omp acp 子进程的审批启动档位；旧状态缺失时按 write 处理。
  approvalProfile?: ApprovalProfile;
  updatedAt: string;
};

type StoredLog = {
  id: string;
  sessionId: string;
  level: 'info' | 'error' | 'tool' | 'permission' | 'diff' | 'done';
  message: string;
  createdAt: string;
};

type DesktopSettings = {
  // 用户指定的 omp 可执行文件路径；为空时使用 PATH 中的 'omp'。
  ompExecutablePath?: string;
};

type DesktopState = {
  recentProjects: StoredProject[];
  recentSessions: StoredSession[];
  logs: StoredLog[];
  configCacheByProjectPath: Record<string, StoredProjectConfigCache>;
  toolModelSnapshotsBySession: Record<string, Record<string, ToolModelSnapshot>>;
  // 全局设置：目前用于指定 omp 可执行文件路径。
  settings?: DesktopSettings;
};

type AgentEvent = {
  sessionId: string;
  type:
    | 'output'
    | 'thought'
    | 'user_message'
    | 'status_update'
    | 'tool_call'
    | 'error'
    | 'done'
    | 'permission_request'
    | 'elicitation_request'
    | 'questionnaire_request'
    | 'elicitation_plan_preview'
    | 'active_plan_update'
    | 'diff'
    | 'config_update'
    | 'commands_update'
    | 'session_update'
    | 'plan'
    | 'usage_update'
    | 'history_loaded';
  message: string;
  payload?: unknown;
};

type DiffSource = 'unstaged' | 'staged';
type GitBranchSwitchFailureReason =
  | 'unmerged-files'
  | 'local-changes'
  | 'untracked-files'
  | 'branch-not-found'
  | 'git-operation-in-progress'
  | 'unknown';

type AcpConfigOption = {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue?: string | boolean;
  options?: Array<{
    value: string;
    name: string;
    description?: string;
  }>;
};

type AcpAvailableCommand = {
  name: string;
  description: string;
};

type StoredProjectConfigCache = {
  configOptions: AcpConfigOption[];
  // 最近一次 ACP available_commands_update 下发的命令列表；新 session 未连上时复用。
  availableCommands: AcpAvailableCommand[];
  updatedAt: string;
};

type ToolModelSnapshot = {
  id: string;
  name: string;
};

interface Window {
  ohMyPiDesktop: {
    getState: () => Promise<DesktopState>;
    selectWorkspace: () => Promise<StoredProject | null>;
    useWorkspace: (workspacePath: string) => Promise<StoredProject>;
    ensureDefaultWorkspace: () => Promise<StoredProject>;
    touchProjectLastOpened: (workspacePath: string) => Promise<StoredProject | null>;
    setProjectPinned: (workspacePath: string, pinned: boolean) => Promise<StoredProject | null>;
    setProjectDisplayName: (workspacePath: string, displayName: string) => Promise<StoredProject | null>;
    removeProject: (workspacePath: string) => Promise<StoredProject | null>;
    revealInExplorer: (workspacePath: string) => Promise<{ ok: boolean; message?: string }>;
    checkOmp: (workspacePath?: string) => Promise<{ installed: boolean; status: string; message: string }>;
    getOmpPath: () => Promise<string>;
    selectOmpPath: () => Promise<{ ok: boolean; path?: string; message?: string }>;
    createSession: (
      projectPath: string,
      title: string,
      approvalProfile: ApprovalProfile
    ) => Promise<StoredSession>;
    startAgent: (sessionId: string, workspacePath: string) => Promise<{ ok: boolean; message: string }>;
    sendAgentMessage: (
      sessionId: string,
      workspacePath: string,
      content: AgentPromptContent
    ) => Promise<{ ok: boolean; message?: string }>;
    getAgentConfig: (
      sessionId: string,
      workspacePath: string
    ) => Promise<{ ok: boolean; configOptions?: AcpConfigOption[]; message?: string }>;
    setAgentConfigOption: (
      sessionId: string,
      workspacePath: string,
      configId: string,
      value: string | boolean
    ) => Promise<{ ok: boolean; configOptions?: AcpConfigOption[]; message?: string }>;
    updateSessionApprovalProfile: (
      sessionId: string,
      workspacePath: string,
      approvalProfile: ApprovalProfile
    ) => Promise<{ ok: boolean; session?: StoredSession; message?: string }>;
    cancelAgentTurn: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
    permissionResponse: (requestId: string, allow: boolean) => Promise<{ ok: boolean; message?: string }>;
    permissionOptionResponse: (requestId: string, optionId: string) => Promise<{ ok: boolean; message?: string }>;
    elicitationResponse: (
      requestId: string,
      action: 'accept' | 'decline' | 'cancel',
      content?: Record<string, unknown>
    ) => Promise<{ ok: boolean; message?: string }>;
    questionnaireResponse: (
      requestId: string,
      action: 'submit' | 'deny',
      answers?: QuestionnaireAnswer[]
    ) => Promise<QuestionnaireResponseResult>;
    // 以 omp session/list 为准重建当前 workspace 的会话列表，返回重建后的完整 DesktopState。
    syncSessions: (
      workspacePath: string,
      keepLocalId?: string
    ) => Promise<{ ok: boolean; state?: DesktopState; message?: string }>;
    loadSession: (
      localSessionId: string,
      workspacePath: string,
      acpSessionId: string
    ) => Promise<{ ok: boolean; sessionId?: string; message?: string }>;
    resumeSession: (
      localSessionId: string,
      workspacePath: string,
      acpSessionId: string
    ) => Promise<{ ok: boolean; sessionId?: string; message?: string }>;
    refreshSessionConfig: (
      localSessionId: string,
      workspacePath: string,
      acpSessionId: string
    ) => Promise<{ ok: boolean; configOptions?: AcpConfigOption[]; message?: string }>;
    forkSession: (
      localSessionId: string,
      workspacePath: string,
      acpSessionId: string
    ) => Promise<{ ok: boolean; sessionId?: string; message?: string }>;
    closeSession: (localSessionId: string) => Promise<{ ok: boolean; message?: string }>;
    stopSessionProcess: (localSessionId: string) => Promise<{ ok: boolean }>;
    getGitBranches: (workspacePath: string) => Promise<{
      ok: boolean;
      branches: string[];
      currentBranch: string;
      message: string;
    }>;
    switchGitBranch: (
      workspacePath: string,
      branchName: string
    ) => Promise<{ ok: boolean; reason: GitBranchSwitchFailureReason | null; message: string }>;
    getDiff: (
      workspacePath: string,
      source?: DiffSource
    ) => Promise<{ ok: boolean; diff: string; message: string }>;
    onAgentEvent: (callback: (event: AgentEvent) => void) => () => void;
  };
}
