export type StoredProject = {
  path: string;
  name: string;
  // 用户自定义显示名；为空时回退到 name（目录名）。
  displayName?: string;
  lastOpenedAt: string;
  // 置顶标记：true 时渲染层会把它固定到项目列表顶部，但持久化顺序不变。
  pinned?: boolean;
};

export type ApprovalProfile = 'always-ask' | 'write' | 'yolo';

export type StoredSession = {
  id: string;
  projectPath: string;
  title: string;
  acpSessionId?: string;
  // 会话对应 omp acp 子进程的审批启动档位；旧状态缺失时按 write 处理。
  approvalProfile?: ApprovalProfile;
  updatedAt: string;
};

export type StoredLog = {
  id: string;
  sessionId: string;
  level: 'info' | 'error' | 'tool' | 'permission' | 'diff' | 'done';
  message: string;
  createdAt: string;
};

export type DesktopSettings = {
  // 用户指定的 omp 可执行文件路径；为空时使用 PATH 中的 'omp'。
  ompExecutablePath?: string;
};

export type DesktopState = {
  recentProjects: StoredProject[];
  recentSessions: StoredSession[];
  logs: StoredLog[];
  configCacheByProjectPath: Record<string, StoredProjectConfigCache>;
  // 工具调用发生时的模型快照：外层 key 是 ACP sessionId，内层 key 是 toolCallId。
  toolModelSnapshotsBySession: Record<string, Record<string, ToolModelSnapshot>>;
  // 全局设置：目前用于指定 omp 可执行文件路径。
  settings?: DesktopSettings;
};

export type AgentEvent = {
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

export type AcpAvailableCommand = {
  name: string;
  description: string;
};

export type StoredProjectConfigCache = {
  configOptions: AcpConfigOption[];
  // 最近一次 ACP available_commands_update 下发的命令列表；新 session 未连上时复用。
  availableCommands: AcpAvailableCommand[];
  updatedAt: string;
};

export type ToolModelSnapshot = {
  id: string;
  name: string;
};

export type AcpConfigOption = {
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

export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
};

