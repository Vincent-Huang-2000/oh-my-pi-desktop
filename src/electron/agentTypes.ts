/**
 * agentTypes — Agent Service 的类型、接口与常量定义。
 *
 * 职责：
 * - 声明所有在 ACP 子进程通信、审批流、问卷、Plan 方案、session
 *   生命周期中使用的结构化类型和常量。
 * - 供 agentUtils / agentQuestionnaire / agentPlan / agentService
 *   以及渲染端（通过 agentService 重导出）引用。
 *
 * 注意：此模块仅包含类型与常量，不引入任何运行时副作用。
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AcpAvailableCommand,
  AcpConfigOption,
  AgentEvent,
  ApprovalProfile,
  StoredSession
} from './types.js';

// ── 常量 ──

export const APPROVAL_SWITCH_CANCEL_TIMEOUT_MS = 1200;
export const MAX_PLAN_PREVIEW_BYTES = 1024 * 1024;
export const ACP_PROTOCOL_VERSION = 1;
export const CLIENT_VERSION = '0.2.0';

// ── 基础类型 ──

export type AgentEventSender = (event: AgentEvent) => void;

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

// ── 进程状态 ──

export type QuestionnaireFollowUp = {
  requestId: string;
  text: string;
};

export type AcpProcessState = {
  child: ChildProcessWithoutNullStreams;
  localSessionId: string;
  localSessionTitle: string;
  workspacePath: string;
  lineBuffer: string;
  nextRequestId: number;
  pendingRequests: Map<JsonRpcId, PendingRequest>;
  ready: Promise<void>;
  acpSessionId?: string;
  restoredAcpSessionId?: string;
  // undefined 仅用于 session/list 临时进程；真实会话始终显式传入审批档位。
  approvalProfile?: ApprovalProfile;
  // 第一次 session/prompt 之前用来恢复/创建 ACP session 的方法。
  // 缺省走 session/load（保留旧行为）；`loadSession/resumeSession/forkSession` 会显式设置。
  initMethod: 'session/load' | 'session/resume' | 'session/fork';
  configOptions: AcpConfigOption[];
  // ACP `available_commands_update` 通知维护的可用 slash 命令。
  // 桌面端不做语义解析，仅透传给 UI 由用户触发 `/<name>` 文本。
  availableCommands: AcpAvailableCommand[];
  closed: boolean;
  // 是否处于 session/load|resume|fork 重放历史的窗口期：
  // 用于在 mapSessionUpdate 给重放出来的 tool_call 加 _replay 标记，
  // 渲染层据此区分实时事件与历史回放；历史模型从本地快照中补回。
  isReplaying: boolean;
  // replay 窗口内聊天事件的处理方式：
  // buffer 用于 session/load 与 fork，suppress 用于只恢复配置的 session/resume。
  replayMode?: 'buffer' | 'suppress';
  replayEvents: AgentEvent[];
  // 当前是否有 session/prompt 尚未结束，用于切换审批档位前受控取消。
  turnActive: boolean;
  // 问卷提交后必须等当前 ACP 回合结束再续发，避免新 prompt 中断仍在执行的 eval。
  questionnaireFollowUps: QuestionnaireFollowUp[];
  // 主动停止子进程后不再向渲染端广播后续进程事件，避免污染对应 session 的消息缓存。
  suppressCloseEvent?: boolean;
};

// ── 审批 / 询问 / 问卷 ──

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: string;
  description?: string;
};

export type PendingPermissionRequest = {
  process: AcpProcessState;
  rpcId: JsonRpcId;
  options: PermissionOption[];
};

export type PendingElicitationRequest = {
  process: AcpProcessState;
  rpcId: JsonRpcId;
  questionnaire?: QuestionnaireDefinition;
};

export type QuestionnaireOption = {
  label: string;
  description?: string;
};

export type QuestionnaireQuestion = {
  question: string;
  header?: string;
  options: QuestionnaireOption[];
  multiSelect: boolean;
};

export type QuestionnaireDefinition = {
  questions: QuestionnaireQuestion[];
};

export type QuestionnaireAnswer = {
  questionIndex: number;
  selections: string[];
};

// 问卷响应结果。失败时 reason 用于区分：
// - 'stale'：pending 请求已不存在，渲染端应从队列移除并推进下一项；
// - 'invalid-answers'：答案校验未通过，pending 请求仍有效，应保留供用户重试。
// 成功时不携带 reason。
export type QuestionnaireResponseResult = {
  ok: boolean;
  message?: string;
  reason?: 'stale' | 'invalid-answers';
};

// ── ACP 会话通知 ──

export type SessionNotification = {
  sessionId?: unknown;
  update?: {
    sessionUpdate?: unknown;
    configOptions?: unknown;
    currentModeId?: unknown;
    availableCommands?: unknown;
    title?: unknown;
    updatedAt?: unknown;
    used?: unknown;
    size?: unknown;
    [key: string]: unknown;
  };
};

// ── Plan 相关 ──

export type HistoricalSessionPlan = {
  id: string;
  toolCallId: string;
  planFilePath: string;
  content: string;
};

export type AcpActivePlan =
  | { version: 1; active: false }
  | { version: 1; active: true; planFilePath: string; content: string | null };

// ── AgentService 公开 API ──

export type AgentPromptContent = {
  text: string;
  // 附件：图片 / 文本 / 其它。替换原先的 images 字段，统一承载文件选择器选中的任意文件。
  attachments?: AgentPromptAttachment[];
};

export type AgentPromptAttachment = {
  // 形如 "data:image/png;base64,xxxx"，AgentService 内部拆出 mime 和 data。
  dataUrl: string;
  // 文件名，用于 chip 展示和 ACP 块的标识。
  fileName?: string;
  // 由渲染层按 MIME + 扩展名预判定的类别，决定走哪种 ACP 块：
  //  - image:      走 { type: 'image' }，omp 能让模型看到（base64 图片）
  //  - text:       base64 解码成字符串后追加到 text 块，omp 能让模型看到
  //  - unsupported: 仍走 { type: 'image' }，omp 会兜底成 `[embedded resource: <uri>]` 占位符，
  //                 模型读不到内容（chip 上由渲染层标警告）
  kind: 'image' | 'text' | 'unsupported';
};

export type ListSessionsResult = {
  ok: boolean;
  sessions?: AcpSessionInfo[];
  nextCursor?: string;
  message?: string;
};

export type AcpSessionInfo = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
};

export type SessionActionResult = {
  ok: boolean;
  message?: string;
  sessionId?: string;
};

export type AgentService = {
  startAgent: (
    sessionId: string,
    workspacePath: string,
    approvalProfile?: ApprovalProfile
  ) => Promise<{ ok: boolean; message: string }>;
  // 发送消息支持富内容：纯文本或 文本+图片块。
  // 图片以 dataURL 形式传入，由 AgentService 解出 mime + base64 写入 ACP `image` content block。
  sendAgentMessage: (
    sessionId: string,
    workspacePath: string,
    content: AgentPromptContent
  ) => Promise<{ ok: boolean; message?: string }>;
  getSessionConfig: (
    sessionId: string,
    workspacePath: string
  ) => Promise<{ ok: boolean; configOptions?: AcpConfigOption[]; message?: string }>;
  // session 级 config：value 可以是字符串（select）或布尔（boolean config option）。
  setSessionConfigOption: (
    sessionId: string,
    workspacePath: string,
    configId: string,
    value: string | boolean
  ) => Promise<{ ok: boolean; configOptions?: AcpConfigOption[]; message?: string }>;
  updateApprovalProfile: (
    sessionId: string,
    workspacePath: string,
    approvalProfile: ApprovalProfile
  ) => Promise<{ ok: boolean; session?: StoredSession; message?: string }>;
  cancelTurn: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
  respondPermissionOption: (requestId: string, optionId: string) => { ok: boolean; message?: string };
  respondPermission: (requestId: string, allow: boolean) => { ok: boolean; message?: string };
  respondElicitation: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ) => { ok: boolean; message?: string };
  respondQuestionnaire: (
    requestId: string,
    action: 'submit' | 'deny',
    answers?: QuestionnaireAnswer[]
  ) => QuestionnaireResponseResult;
  // 会话生命周期：列表 / 加载 / 恢复 / Fork / 关闭，全部对应 ACP 原生方法。
  listSessions: (workspacePath: string, cursor?: string) => Promise<ListSessionsResult>;
  loadSession: (localSessionId: string, workspacePath: string, acpSessionId: string) => Promise<SessionActionResult>;
  resumeSession: (localSessionId: string, workspacePath: string, acpSessionId: string) => Promise<SessionActionResult>;
  refreshSessionConfig: (
    localSessionId: string,
    workspacePath: string,
    acpSessionId: string
  ) => Promise<{ ok: boolean; configOptions?: AcpConfigOption[]; message?: string }>;
  forkSession: (localSessionId: string, workspacePath: string, sourceAcpSessionId: string, title: string) => Promise<SessionActionResult>;
  closeSession: (localSessionId: string) => SessionActionResult;
  // 彻底杀掉指定 session 的子进程（丢弃 session 时调用）。
  stopSessionProcess: (localSessionId: string) => void;
  stopAll: () => void;
};
