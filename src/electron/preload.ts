import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

// 渲染端发送给主进程的 prompt 富内容。
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

// ACP 会话信息（对应 ACP SessionInfo）。
type AcpSessionInfo = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
};

type AgentEvent = {
  sessionId: string;
  type:
    | 'output'
    | 'user_message'
    | 'status_update'
    | 'tool_call'
    | 'error'
    | 'done'
    | 'permission_request'
    | 'elicitation_request'
    | 'questionnaire_request'
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
type ApprovalProfile = 'always-ask' | 'write' | 'yolo';

const desktop = {
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  // 选择 workspace 目录：主进程弹 dialog.showOpenDialog 并 upsert 项目。
  selectWorkspace: () => ipcRenderer.invoke('desktop:select-workspace'),
  // 直接使用某个已有路径作为 workspace（不走 dialog）。
  useWorkspace: (workspacePath: string) =>
    ipcRenderer.invoke('desktop:use-workspace', workspacePath),
  // 首次启动兜底：在用户文档目录下创建 omp-desktop 文件夹并 upsert 为项目。
  ensureDefaultWorkspace: () => ipcRenderer.invoke('desktop:ensure-default-workspace'),
  // 仅更新 lastOpenedAt，不重排项目顺序（用于点击 session 进入执行目录时记录最近操作时间）。
  touchProjectLastOpened: (workspacePath: string) =>
    ipcRenderer.invoke('desktop:touch-project-last-opened', workspacePath),
  // 切换项目置顶标记。
  setProjectPinned: (workspacePath: string, pinned: boolean) =>
    ipcRenderer.invoke('desktop:set-project-pinned', workspacePath, pinned),
  // 设置项目自定义显示名；空字符串/与目录名相同则清除。
  setProjectDisplayName: (workspacePath: string, displayName: string) =>
    ipcRenderer.invoke('desktop:set-project-display-name', workspacePath, displayName),
  // 从 recentProjects 移除项目（会话行保留，磁盘 omp 会话不动）。
  removeProject: (workspacePath: string) =>
    ipcRenderer.invoke('desktop:remove-project', workspacePath),
  // 在系统资源管理器中打开项目目录。
  revealInExplorer: (workspacePath: string) =>
    ipcRenderer.invoke('desktop:reveal-in-explorer', workspacePath),
  // 探测 omp 是否安装可用（omp --version / omp acp --help）。
  checkOmp: (workspacePath?: string) => ipcRenderer.invoke('desktop:check-omp', workspacePath),
  // 读取当前用户指定的 omp 可执行文件路径（空字符串表示使用 PATH 中的 'omp'）。
  getOmpPath: () => ipcRenderer.invoke('desktop:get-omp-path'),
  // 打开文件选择对话框选择 omp 可执行文件，保存设置并验证。
  selectOmpPath: () => ipcRenderer.invoke('desktop:select-omp-path'),
  createSession: (projectPath: string, title: string, approvalProfile: ApprovalProfile) =>
    ipcRenderer.invoke('desktop:create-session', projectPath, title, approvalProfile),
  startAgent: (sessionId: string, workspacePath: string) =>
    ipcRenderer.invoke('desktop:start-agent', sessionId, workspacePath),
  sendAgentMessage: (sessionId: string, workspacePath: string, content: AgentPromptContent) =>
    ipcRenderer.invoke('desktop:send-agent-message', sessionId, workspacePath, content),
  getAgentConfig: (sessionId: string, workspacePath: string) =>
    ipcRenderer.invoke('desktop:get-agent-config', sessionId, workspacePath),
  setAgentConfigOption: (sessionId: string, workspacePath: string, configId: string, value: string | boolean) =>
    ipcRenderer.invoke('desktop:set-agent-config-option', sessionId, workspacePath, configId, value),
  updateSessionApprovalProfile: (
    sessionId: string,
    workspacePath: string,
    approvalProfile: ApprovalProfile
  ) => ipcRenderer.invoke(
    'desktop:update-session-approval-profile',
    sessionId,
    workspacePath,
    approvalProfile
  ),
  cancelAgentTurn: (sessionId: string) => ipcRenderer.invoke('desktop:cancel-agent-turn', sessionId),
  permissionResponse: (requestId: string, allow: boolean) =>
    ipcRenderer.invoke('desktop:permission-response', requestId, allow),
  permissionOptionResponse: (requestId: string, optionId: string) =>
    ipcRenderer.invoke('desktop:permission-option-response', requestId, optionId),
  // ACP elicitation/create 响应：accept 携带 content（{ value: ... }），decline/cancel 不带。
  elicitationResponse: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ) => ipcRenderer.invoke('desktop:elicitation-response', requestId, action, content),
  questionnaireResponse: (
    requestId: string,
    action: 'submit' | 'deny',
    answers?: QuestionnaireAnswer[]
  ) => ipcRenderer.invoke('desktop:questionnaire-response', requestId, action, answers),
  // 以 omp session/list 为准重建当前 workspace 的会话列表（去重 + 清理幽灵），keepLocalId 保活动会话。
  syncSessions: (workspacePath: string, keepLocalId?: string) =>
    ipcRenderer.invoke('desktop:sync-sessions', workspacePath, keepLocalId),
  loadSession: (localSessionId: string, workspacePath: string, acpSessionId: string) =>
    ipcRenderer.invoke('desktop:load-session', localSessionId, workspacePath, acpSessionId),
  resumeSession: (localSessionId: string, workspacePath: string, acpSessionId: string) =>
    ipcRenderer.invoke('desktop:resume-session', localSessionId, workspacePath, acpSessionId),
  refreshSessionConfig: (localSessionId: string, workspacePath: string, acpSessionId: string) =>
    ipcRenderer.invoke('desktop:refresh-session-config', localSessionId, workspacePath, acpSessionId),
  forkSession: (localSessionId: string, workspacePath: string, sourceAcpSessionId: string) =>
    ipcRenderer.invoke('desktop:fork-session', localSessionId, workspacePath, sourceAcpSessionId),
  closeSession: (localSessionId: string) => ipcRenderer.invoke('desktop:close-session', localSessionId),
  stopSessionProcess: (localSessionId: string) => ipcRenderer.invoke('desktop:stop-session-process', localSessionId),
  getGitBranches: (workspacePath: string) =>
    ipcRenderer.invoke('desktop:get-git-branches', workspacePath),
  switchGitBranch: (workspacePath: string, branchName: string) =>
    ipcRenderer.invoke('desktop:switch-git-branch', workspacePath, branchName),
  getDiff: (workspacePath: string, source?: DiffSource) =>
    ipcRenderer.invoke('desktop:get-diff', workspacePath, source),
  onAgentEvent: (callback: (event: AgentEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: AgentEvent) => callback(payload);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  }
};

contextBridge.exposeInMainWorld('ohMyPiDesktop', desktop);
