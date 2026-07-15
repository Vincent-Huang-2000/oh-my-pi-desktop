import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  addLog,
  copyToolModelSnapshots,
  getSetting,
  getToolModelSnapshot,
  normalizeApprovalProfile,
  readState,
  saveToolModelSnapshot,
  updateProjectCommandsCache,
  updateProjectConfigCache,
  updateSessionApprovalProfile,
  upsertSession
} from './state.js';
import type {
  AcpAvailableCommand,
  AcpConfigOption,
  AgentEvent,
  ApprovalProfile,
  StoredLog,
  StoredSession,
  ToolModelSnapshot
} from './types.js';

export type AgentEventSender = (event: AgentEvent) => void;
const APPROVAL_SWITCH_CANCEL_TIMEOUT_MS = 1200;
const MAX_PLAN_PREVIEW_BYTES = 1024 * 1024;

type HistoricalSessionPlan = {
  id: string;
  toolCallId: string;
  planFilePath: string;
  content: string;
};

type AcpActivePlan =
  | { version: 1; active: false }
  | { version: 1; active: true; planFilePath: string; content: string | null };

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
  forkSession: (localSessionId: string, workspacePath: string, sourceAcpSessionId: string) => Promise<SessionActionResult>;
  closeSession: (localSessionId: string) => SessionActionResult;
  // 彻底杀掉指定 session 的子进程（丢弃 session 时调用）。
  stopSessionProcess: (localSessionId: string) => void;
  stopAll: () => void;
};

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

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type AcpProcessState = {
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
  initMethod: 'session/load' | 'session/resume' | 'unstable_session/fork';
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

type PendingPermissionRequest = {
  process: AcpProcessState;
  rpcId: JsonRpcId;
  options: PermissionOption[];
};

type PendingElicitationRequest = {
  process: AcpProcessState;
  rpcId: JsonRpcId;
  questionnaire?: QuestionnaireDefinition;
};

type QuestionnaireOption = {
  label: string;
  description?: string;
};

type QuestionnaireQuestion = {
  question: string;
  header?: string;
  options: QuestionnaireOption[];
  multiSelect: boolean;
};

type QuestionnaireDefinition = {
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

type QuestionnaireFollowUp = {
  requestId: string;
  text: string;
};

type PermissionOption = {
  optionId: string;
  name: string;
  kind: string;
  description?: string;
};

type SessionNotification = {
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

const ACP_PROTOCOL_VERSION = 1;
const CLIENT_VERSION = '0.1.0';

const getLogLevel = (eventType: AgentEvent['type']): StoredLog['level'] => {
  if (eventType === 'tool_call') {
    return 'tool';
  }
  if (eventType === 'done') {
    return 'done';
  }
  if (eventType === 'diff') {
    return 'diff';
  }
  if (eventType === 'error') {
    return 'error';
  }
  return 'info';
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

// 仅识别 Plan 模式约定的静态 Python 问卷；不执行、不推断任意 Python 代码。
const parseQuestionnaireEval = (message: string): QuestionnaireDefinition | null => {
  const header = /^Allow tool:\s*eval\s*\r?\nLanguage:\s*python\s*\r?\nCode:\s*\r?\n([\s\S]+)$/.exec(message);
  if (!header) return null;
  const code = header[1];
  const assignment = /^[ \t]*questions[ \t]*=[ \t]*/.exec(code);
  if (!assignment || code[assignment[0].length] !== '[') return null;

  const start = assignment[0].length;
  let depth = 0;
  let quote = '';
  let escaped = false;
  let end = -1;
  for (let index = start; index < code.length; index += 1) {
    const char = code[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
      if (depth < 0) return null;
    }
  }
  if (end < 0 || quote) return null;

  // 列表之外只允许 json 导入和 questions 序列化打印，避免任意 eval 被伪装为问卷。
  const tail = code.slice(end);
  if (!/^\s*import\s+json\s*\r?\n\s*print\s*\(\s*json\.dumps\s*\(\s*questions(?:\s*,\s*(?:ensure_ascii\s*=\s*(?:True|False)|indent\s*=\s*\d+))*\s*\)\s*\)\s*$/.test(tail)) {
    return null;
  }

  // 示例为 JSON 风格字面量，只额外兼容 Python 的 True/False/None 常量。
  const literal = code.slice(start, end);
  let normalized = '';
  quote = '';
  escaped = false;
  for (let index = 0; index < literal.length; index += 1) {
    const char = literal[index];
    if (quote) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      normalized += char;
      continue;
    }
    const word = /^(True|False|None)\b/.exec(literal.slice(index));
    if (word) {
      normalized += word[1] === 'True' ? 'true' : word[1] === 'False' ? 'false' : 'null';
      index += word[1].length - 1;
    } else {
      normalized += char;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const questions: QuestionnaireQuestion[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.question !== 'string' || !item.question.trim() ||
      typeof item.multiSelect !== 'boolean' || !Array.isArray(item.options) || item.options.length === 0) {
      return null;
    }
    const options: QuestionnaireOption[] = [];
    for (const option of item.options) {
      if (!isRecord(option) || typeof option.label !== 'string' || !option.label.trim() ||
        (option.description !== undefined && typeof option.description !== 'string')) {
        return null;
      }
      options.push({
        label: option.label,
        ...(typeof option.description === 'string' ? { description: option.description } : {})
      });
    }
    questions.push({
      question: item.question,
      ...(typeof item.header === 'string' && item.header.trim() ? { header: item.header } : {}),
      options,
      multiSelect: item.multiSelect
    });
  }
  return { questions };
};

const validateQuestionnaireAnswers = (
  questionnaire: QuestionnaireDefinition,
  answers: QuestionnaireAnswer[] | undefined
): QuestionnaireAnswer[] | null => {
  if (!Array.isArray(answers) || answers.length !== questionnaire.questions.length) return null;
  const normalized: QuestionnaireAnswer[] = [];
  for (let index = 0; index < questionnaire.questions.length; index += 1) {
    const answer = answers.find((item) => item?.questionIndex === index);
    const question = questionnaire.questions[index];
    if (!answer || !Array.isArray(answer.selections) || answer.selections.length === 0 ||
      (!question.multiSelect && answer.selections.length !== 1)) {
      return null;
    }
    const allowed = new Set(question.options.map((option) => option.label));
    const selections = [...new Set(answer.selections)];
    if (selections.length !== answer.selections.length || selections.some((value) => typeof value !== 'string' || !allowed.has(value))) {
      return null;
    }
    normalized.push({ questionIndex: index, selections });
  }
  return normalized;
};

const formatQuestionnaireFollowUp = (
  questionnaire: QuestionnaireDefinition,
  answers: QuestionnaireAnswer[]
) => [
  '用户已提交问卷答案，请据此继续当前 Plan 工作：',
  ...answers.map((answer) => {
    const question = questionnaire.questions[answer.questionIndex];
    return `- ${question.header ? `[${question.header}] ` : ''}${question.question}：${answer.selections.join('、')}`;
  })
].join('\n');

const isJsonRpcRequest = (value: unknown): value is JsonRpcRequest => {
  return isRecord(value) && value.jsonrpc === '2.0' && 'id' in value && typeof value.method === 'string';
};

const isJsonRpcNotification = (value: unknown): value is JsonRpcNotification => {
  return isRecord(value) && value.jsonrpc === '2.0' && !('id' in value) && typeof value.method === 'string';
};

const isJsonRpcResponse = (value: unknown): value is JsonRpcResponse => {
  return isRecord(value) && value.jsonrpc === '2.0' && 'id' in value && !('method' in value);
};

const getTextContent = (value: unknown): string => {
  if (!isRecord(value)) {
    return '';
  }
  const text = value.text;
  return typeof text === 'string' ? text : '';
};

const stringifySafe = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const getToolCallMessage = (update: Record<string, unknown>) => {
  const title = update.title;
  if (typeof title === 'string' && title.trim()) {
    return title;
  }
  return '';
};

const getToolCallId = (update: Record<string, unknown>) => {
  return typeof update.toolCallId === 'string' ? update.toolCallId : '';
};

const getAcpSessionIdForSnapshot = (process: AcpProcessState, params: SessionNotification) => {
  if (typeof params.sessionId === 'string') {
    return params.sessionId;
  }
  return process.acpSessionId ?? process.restoredAcpSessionId ?? '';
};

const getCurrentModelSnapshot = (configOptions: AcpConfigOption[]): ToolModelSnapshot | undefined => {
  const modelOpt = configOptions.find((option) => option.id === 'model');
  if (!modelOpt || typeof modelOpt.currentValue !== 'string') {
    return undefined;
  }
  const id = modelOpt.currentValue;
  const name = modelOpt.options?.find((option) => option.value === id)?.name ?? id;
  return { id, name };
};

const getPermissionMessage = (params: unknown) => {
  if (!isRecord(params)) {
    return 'agent 请求权限审批';
  }

  const directMessage = params.message ?? params.prompt ?? params.question ?? params.title;
  if (typeof directMessage === 'string' && directMessage.trim()) {
    return directMessage.trim();
  }

  if (!isRecord(params.toolCall)) {
    return 'agent 请求你选择下一步';
  }

  const title = params.toolCall.title;
  if (typeof title === 'string' && title.trim()) {
    return title;
  }

  return 'agent 请求权限审批';
};

const getPlanMessage = (update: Record<string, unknown>) => {
  const entries = Array.isArray(update.entries) ? update.entries : [];
  if (entries.length === 0) {
    return 'agent 清空了任务计划';
  }

  const statusMap: Record<string, string> = {
    pending: '待处理',
    in_progress: '进行中',
    completed: '已完成'
  };

  return entries
    .map((entry, index) => {
      if (!isRecord(entry)) {
        return `${index + 1}. 未知任务`;
      }
      const content = typeof entry.content === 'string' ? entry.content : '未知任务';
      const status = typeof entry.status === 'string' ? statusMap[entry.status] ?? entry.status : '未知状态';
      return `${index + 1}. [${status}] ${content}`;
    })
    .join('\n');
};

const findSessionLocalDir = async (process: AcpProcessState) => {
  const sessionId = process.localSessionId;
  const acpSessionId = process.acpSessionId ?? process.restoredAcpSessionId;
  if (!acpSessionId) {
    addLog(sessionId, 'info', `[plan-preview] acpSessionId 缺失，无法定位方案文件`);
    return null;
  }
  const agentDir = globalThis.process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), '.omp', 'agent');
  const sessionsRoot = path.join(agentDir, 'sessions');
  try {
    const projects = await readdir(sessionsRoot, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectRoot = path.join(sessionsRoot, project.name);
      const sessions = await readdir(projectRoot, { withFileTypes: true });
      const session = sessions.find((entry) => entry.isDirectory() && entry.name.endsWith(`_${acpSessionId}`));
      if (!session) continue;
      return path.join(projectRoot, session.name, 'local');
    }
    // 遍历完所有项目目录都没找到以 _<acpSessionId> 结尾的 session 目录。
    addLog(sessionId, 'info', `[plan-preview] 未找到 session 目录（应 endsWith _${acpSessionId}），已扫描根：${sessionsRoot}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    addLog(sessionId, 'info', `[plan-preview] 定位 session 目录抛异常：${reason}`);
  }
  return null;
};

const getAcpActivePlan = (response: unknown): AcpActivePlan | null => {
  if (!isRecord(response) || !isRecord(response._meta)) return null;
  const planMode = response._meta['omp.planMode'];
  if (!isRecord(planMode) || planMode.version !== 1 || typeof planMode.active !== 'boolean') {
    return null;
  }
  if (!planMode.active) {
    return { version: 1, active: false };
  }
  if (
    typeof planMode.planFilePath !== 'string' ||
    (typeof planMode.content !== 'string' && planMode.content !== null)
  ) {
    return null;
  }
  return {
    version: 1,
    active: true,
    planFilePath: planMode.planFilePath,
    content: planMode.content
  };
};

const readPlanFile = async (
  process: AcpProcessState,
  localDir: string,
  filePath: string,
  logPrefix: 'plan-preview' | 'plan-history'
) => {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > MAX_PLAN_PREVIEW_BYTES) {
      if (fileStat.size > MAX_PLAN_PREVIEW_BYTES) {
        addLog(process.localSessionId, 'info', `[${logPrefix}] 方案文件超 ${(MAX_PLAN_PREVIEW_BYTES / 1024 / 1024).toFixed(0)}MB 上限：${fileStat.size} 字节，${filePath}`);
      }
      return null;
    }
    // realpath 同时防止历史 payload 通过符号链接逃逸到当前 ACP session 的 local 目录外。
    const [resolvedLocalDir, resolvedFilePath] = await Promise.all([realpath(localDir), realpath(filePath)]);
    const relativePath = path.relative(resolvedLocalDir, resolvedFilePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null;
    }
    return await readFile(resolvedFilePath, 'utf8');
  } catch {
    return null;
  }
};

const resolveHistoricalPlanPath = (localDir: string, planFilePath: string) => {
  if (!planFilePath.startsWith('local://')) {
    return null;
  }
  const fileName = planFilePath.slice('local://'.length);
  // OMP plan-mode 文件位于 local 根目录；拒绝子目录、绝对路径与目录穿越。
  if (!fileName || path.basename(fileName) !== fileName || !/(?:^|-)plan\.md$/i.test(fileName)) {
    return null;
  }
  return path.join(localDir, fileName);
};

// 实时审批没有通过协议携带精确 planFilePath，继续扫描当前 session 的 local 目录，
// 取 mtime 最新的 *-plan.md；历史恢复则走下方的精确路径读取，不使用这个降级。
const readFullPlanForApproval = async (process: AcpProcessState) => {
  const localDir = await findSessionLocalDir(process);
  if (!localDir) return null;
  try {
    const localEntries = await readdir(localDir, { withFileTypes: true });
    const planFiles = localEntries.filter((entry) => entry.isFile() && entry.name.endsWith('-plan.md'));
    if (planFiles.length === 0) {
      // 无 *-plan.md 文件——可能不是 plan 审批（如普通工具审批），静默返回。
      return null;
    }
    // 取 mtime 最新的一个；并发写入时最新的即当前方案。
    let latest: { path: string; mtime: number; size: number } | null = null;
    for (const entry of planFiles) {
      const filePath = path.join(localDir, entry.name);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
      if (fileStat.mtimeMs > (latest?.mtime ?? -1)) {
        latest = { path: filePath, mtime: fileStat.mtimeMs, size: fileStat.size };
      }
    }
    if (!latest) {
      addLog(process.localSessionId, 'info', `[plan-preview] local 下 *-plan.md 均非常规文件：${localDir}`);
      return null;
    }
    const content = await readPlanFile(process, localDir, latest.path, 'plan-preview');
    if (content) {
      addLog(process.localSessionId, 'info', `[plan-preview] 命中磁盘完整方案：${latest.path}（${latest.size} 字节）`);
    }
    return content;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    addLog(process.localSessionId, 'info', `[plan-preview] 读取磁盘方案抛异常：${reason}`);
    return null;
  }
};

const readHistoricalSessionPlans = async (
  process: AcpProcessState,
  replayEvents: AgentEvent[]
): Promise<HistoricalSessionPlan[]> => {
  const applyToolCallIds = new Set<string>();
  const referencedPlans = new Map<string, { toolCallId: string; planFilePath: string }>();
  for (const event of replayEvents) {
    if (event.type !== 'tool_call' || !isRecord(event.payload)) continue;
    const update = isRecord(event.payload.update) ? event.payload.update : undefined;
    if (!update || typeof update.toolCallId !== 'string') continue;
    if (update.title === 'resolve' && isRecord(update.rawInput) && update.rawInput.action === 'apply') {
      applyToolCallIds.add(update.toolCallId);
    }
    const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : undefined;
    const details = rawOutput && isRecord(rawOutput.details) ? rawOutput.details : undefined;
    const planFilePath = details?.planFilePath;
    if (
      !applyToolCallIds.has(update.toolCallId) ||
      details?.planExists !== true ||
      typeof planFilePath !== 'string'
    ) {
      continue;
    }
    // 同一路径可能经历多次“继续完善”；只保留最后一次 resolve apply 的最终文件内容。
    referencedPlans.delete(planFilePath);
    referencedPlans.set(planFilePath, { toolCallId: update.toolCallId, planFilePath });
  }
  if (referencedPlans.size === 0) return [];
  const localDir = await findSessionLocalDir(process);
  if (!localDir) return [];
  const plans: HistoricalSessionPlan[] = [];
  for (const reference of referencedPlans.values()) {
    const filePath = resolveHistoricalPlanPath(localDir, reference.planFilePath);
    if (!filePath) {
      addLog(process.localSessionId, 'info', `[plan-history] 拒绝不安全或非 plan 路径：${reference.planFilePath}`);
      continue;
    }
    const content = await readPlanFile(process, localDir, filePath, 'plan-history');
    if (!content) {
      addLog(process.localSessionId, 'info', `[plan-history] 历史方案文件不存在或不可读：${reference.planFilePath}`);
      continue;
    }
    plans.push({
      id: `history-plan-${reference.toolCallId}`,
      toolCallId: reference.toolCallId,
      planFilePath: reference.planFilePath,
      content
    });
  }
  return plans;
};

const getPlanUpdateMessage = (update: Record<string, unknown>) => {
  if (!isRecord(update.plan)) {
    return 'agent 更新了任务计划';
  }
  if (update.plan.type === 'items') {
    return getPlanMessage(update.plan);
  }
  if (update.plan.type === 'markdown' && typeof update.plan.content === 'string') {
    return update.plan.content;
  }
  if (update.plan.type === 'file' && typeof update.plan.uri === 'string') {
    return `计划文件：${update.plan.uri}`;
  }
  return 'agent 更新了任务计划';
};

const normalizeConfigOptions = (value: unknown): AcpConfigOption[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.type !== 'string') {
      return [];
    }

    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
          if (!isRecord(option) || typeof option.value !== 'string' || typeof option.name !== 'string') {
            return [];
          }
          return [
            {
              value: option.value,
              name: option.name,
              description: typeof option.description === 'string' ? option.description : undefined
            }
          ];
        })
      : undefined;

    return [
      {
        id: item.id,
        name: item.name,
        category: typeof item.category === 'string' ? item.category : undefined,
        type: item.type,
        currentValue:
          typeof item.currentValue === 'string' || typeof item.currentValue === 'boolean' ? item.currentValue : undefined,
        options
      }
    ];
  });
};

const normalizePermissionOptions = (value: unknown): PermissionOption[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.optionId !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.kind !== 'string'
    ) {
      return [];
    }
    return [
      {
        optionId: item.optionId,
        name: item.name,
        kind: item.kind,
        description: typeof item.description === 'string' ? item.description : undefined
      }
    ];
  });
};

export const createAgentService = (sendAgentEvent: AgentEventSender): AgentService => {
  const agentProcesses = new Map<string, AcpProcessState>();
  const pendingPermissions = new Map<string, PendingPermissionRequest>();
  const pendingElicitations = new Map<string, PendingElicitationRequest>();

  const getStoredApprovalProfile = (sessionId: string) => {
    const session = readState().recentSessions.find((item) => item.id === sessionId);
    return normalizeApprovalProfile(session?.approvalProfile);
  };

  const hasPendingPermissionsForProcess = (process: AcpProcessState) => {
    return Array.from(pendingPermissions.values()).some((pending) => pending.process === process);
  };

  const waitForTurnToSettle = async (
    process: AcpProcessState,
    timeoutMs = APPROVAL_SWITCH_CANCEL_TIMEOUT_MS
  ) => {
    const startedAt = Date.now();
    while (process.turnActive && Date.now() - startedAt < timeoutMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  };

  const clearPendingPermissionsForProcess = (process: AcpProcessState) => {
    pendingPermissions.forEach((pending, requestId) => {
      if (pending.process === process) {
        pendingPermissions.delete(requestId);
      }
    });
  };

  const cancelPendingPermissionsForProcess = (process: AcpProcessState) => {
    pendingPermissions.forEach((pending, requestId) => {
      if (pending.process === process) {
        sendResponse(process, pending.rpcId, { outcome: { outcome: 'cancelled' } });
        pendingPermissions.delete(requestId);
      }
    });
  };

  // elicitation 的进程级清理，与权限清理逻辑对称。
  // elicitation 响应结构为 { action: 'cancel' }（ACP CreateElicitationResponse）。
  const clearPendingElicitationsForProcess = (process: AcpProcessState) => {
    pendingElicitations.forEach((pending, requestId) => {
      if (pending.process === process) {
        pendingElicitations.delete(requestId);
      }
    });
  };

  const cancelPendingElicitationsForProcess = (process: AcpProcessState) => {
    pendingElicitations.forEach((pending, requestId) => {
      if (pending.process === process) {
        sendResponse(process, pending.rpcId, { action: 'cancel' });
        pendingElicitations.delete(requestId);
      }
    });
  };

  const emitEvent = (event: AgentEvent) => {
    addLog(event.sessionId, getLogLevel(event.type), event.message);
    sendAgentEvent(event);
  };

  const isReplayMessageEvent = (event: AgentEvent) =>
    event.type === 'user_message' ||
    event.type === 'output' ||
    event.type === 'tool_call' ||
    event.type === 'plan' ||
    event.type === 'status_update' ||
    event.type === 'done' ||
    event.type === 'error' ||
    event.type === 'diff';

  const updateConfigOptions = (process: AcpProcessState, configOptions: unknown) => {
    const normalized = normalizeConfigOptions(configOptions);
    if (normalized.length === 0) {
      return;
    }

    process.configOptions = normalized;
    updateProjectConfigCache(process.workspacePath, normalized);
    emitEvent({
      sessionId: process.localSessionId,
      type: 'config_update',
      message: 'ACP 配置已更新',
      payload: { configOptions: normalized }
    });
  };

  const updateCurrentMode = (process: AcpProcessState, modeId: unknown) => {
    if (typeof modeId !== 'string') {
      return;
    }

    if (!process.configOptions.some((option) => option.id === 'mode')) {
      return;
    }

    process.configOptions = process.configOptions.map((option) =>
      option.id === 'mode' ? { ...option, currentValue: modeId } : option
    );
    emitEvent({
      sessionId: process.localSessionId,
      type: 'config_update',
      message: 'ACP 模式已更新',
      payload: { configOptions: process.configOptions }
    });
  };

  const updateStoredSessionInfo = (process: AcpProcessState, update: Record<string, unknown>) => {
    const title =
      typeof update.title === 'string' && update.title.trim() ? update.title.trim() : process.localSessionTitle;
    const updatedAt = typeof update.updatedAt === 'string' ? update.updatedAt : undefined;
    process.localSessionTitle = title;
    const session = upsertSession(
      process.workspacePath,
      process.localSessionId,
      title,
      process.acpSessionId,
      updatedAt,
      undefined,
      process.approvalProfile
    );
    emitEvent({
      sessionId: process.localSessionId,
      type: 'session_update',
      message: 'session 信息已更新',
      payload: { session }
    });
  };

  // 把 ACP `available_commands_update` 通知归一化：仅保留 name/description。
  const normalizeAvailableCommands = (value: unknown): AcpAvailableCommand[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.flatMap((item) => {
      if (!isRecord(item) || typeof item.name !== 'string') {
        return [];
      }
      return [
        {
          name: item.name,
          description: typeof item.description === 'string' ? item.description : ''
        }
      ];
    });
  };

  const getAvailableCommandsMessage = (count: number) => `可用命令已更新：${count} 个`;

  // v16.1.13 agent 在每轮结束发出 usage_update，携带上下文用量与可选费用。
  // payload.update 形如 { used, size, cost?: { amount, currency } }。
  const getUsageMessage = (update: Record<string, unknown>) => {
    const used = typeof update.used === 'number' ? update.used : 0;
    const size = typeof update.size === 'number' ? update.size : 0;
    const costRecord = isRecord(update.cost) ? update.cost : undefined;
    const amount = costRecord && typeof costRecord.amount === 'number' ? costRecord.amount : 0;
    const currency = costRecord && typeof costRecord.currency === 'string' ? costRecord.currency : 'USD';
    const usageText = size > 0 ? `上下文用量：${used}/${size} tokens` : `上下文用量：${used} tokens`;
    return amount > 0 ? `${usageText} · ${currency === 'USD' ? '$' : ''}${amount.toFixed(4)}` : usageText;
  };

  const writeMessage = (process: AcpProcessState, message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse) => {
    process.child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const sendResponse = (process: AcpProcessState, id: JsonRpcId, result: unknown) => {
    writeMessage(process, { jsonrpc: '2.0', id, result });
  };

  const sendErrorResponse = (process: AcpProcessState, id: JsonRpcId, code: number, message: string) => {
    writeMessage(process, { jsonrpc: '2.0', id, error: { code, message } });
  };

  const sendRequest = (process: AcpProcessState, method: string, params: unknown) => {
    const id = `${process.localSessionId}-${process.nextRequestId++}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      process.pendingRequests.set(id, { resolve, reject });
    });
    writeMessage(process, { jsonrpc: '2.0', id, method, params });
    return promise;
  };

  const handleResponse = (process: AcpProcessState, message: JsonRpcResponse) => {
    const pending = process.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    process.pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  };

  // ACP 的 session/update 是结构化通知，这里只转换桌面端当前 UI 已能展示的事件。
  const mapSessionUpdate = (process: AcpProcessState, params: SessionNotification): AgentEvent[] => {
    const update = params.update;
    if (!isRecord(update)) {
      return [];
    }

    const sessionId = process.localSessionId;
    const sessionUpdate = update.sessionUpdate;
    if (sessionUpdate === 'user_message_chunk') {
      const message = getTextContent(update.content);
      return message ? [{ sessionId, type: 'user_message', message, payload: params }] : [];
    }
    if (sessionUpdate === 'agent_message_chunk') {
      const message = getTextContent(update.content);
      return message ? [{ sessionId, type: 'output', message, payload: params }] : [];
    }
    if (sessionUpdate === 'agent_thought_chunk') {
      const message = getTextContent(update.content);
      return message ? [{ sessionId, type: 'thought', message, payload: params }] : [];
    }
    if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
      // 不再把带 diff 的 update 分流成独立 diff 文本气泡：统一回流到 tool_call 事件，
      // 由渲染层按 toolCallId 原地更新同一张工具卡片（状态/diff/输出实时刷新）。
      const toolCallId = getToolCallId(update);
      const snapshotSessionId = getAcpSessionIdForSnapshot(process, params);
      const realtimeModel = getCurrentModelSnapshot(process.configOptions);
      const toolModel =
        process.isReplaying && snapshotSessionId && toolCallId
          ? getToolModelSnapshot(snapshotSessionId, toolCallId)
          : realtimeModel;
      if (!process.isReplaying && snapshotSessionId && toolCallId && realtimeModel) {
        saveToolModelSnapshot(snapshotSessionId, toolCallId, realtimeModel);
      }
      // replay 窗口期内（session/load|resume|fork 重放历史）给 payload 附 _replay: true；
      // 若本地已记录过模型快照，也一并带回渲染层还原工具卡片头部。
      const payload: unknown = {
        ...(params as Record<string, unknown>),
        ...(process.isReplaying ? { _replay: true } : {}),
        ...(toolModel ? { toolModel } : {})
      };
      return [{ sessionId, type: 'tool_call', message: getToolCallMessage(update), payload }];
    }
    if (sessionUpdate === 'plan') {
      return [{ sessionId, type: 'plan', message: getPlanMessage(update), payload: params }];
    }
    if (sessionUpdate === 'plan_update') {
      return [{ sessionId, type: 'plan', message: getPlanUpdateMessage(update), payload: params }];
    }
    if (sessionUpdate === 'plan_removed') {
      return [{ sessionId, type: 'plan', message: 'agent 移除了任务计划', payload: params }];
    }
    // 协议兼容分支：omp 当前在 ACP 模式下会把 slash 命令的输出转成
    // `agent_message_chunk`（见 omp 的 #emitCommandOutput），所以桌面端实际
    // 不会收到 `command_output` 帧。保留此分支是为：
    //   1) 协议未来若改回 `command_output`，桌面端能直接兼容；
    //   2) 第三方 agent 实现走 ACP 规范中描述的 `command_output` 通道时也能透出。
    // 命中后以普通 `output` 形式进入现有消息流（与 chunk 路径一致），避免出现
    // “执行了命令但界面无反馈”的情况。
    if (sessionUpdate === 'command_output') {
      const output = typeof update.output === 'string' ? update.output : '';
      return output ? [{ sessionId, type: 'output', message: output, payload: params }] : [];
    }
    if (sessionUpdate === 'config_option_update') {
      updateConfigOptions(process, update.configOptions);
      return [];
    }
    if (sessionUpdate === 'current_mode_update') {
      updateCurrentMode(process, update.currentModeId);
      const modeId = typeof update.currentModeId === 'string' ? update.currentModeId : '未知模式';
      return [{ sessionId, type: 'status_update', message: `当前模式：${modeId}`, payload: params }];
    }
    if (sessionUpdate === 'available_commands_update') {
      const commands = normalizeAvailableCommands(update.availableCommands);
      process.availableCommands = commands;
      // 按项目缓存命令列表：新 session 未连上 ACP 时复用，让输入 / 立刻有命令可选。
      updateProjectCommandsCache(process.workspacePath, commands);
      return [
        {
          sessionId,
          type: 'commands_update',
          message: getAvailableCommandsMessage(commands.length),
          payload: { commands }
        }
      ];
    }
    if (sessionUpdate === 'session_info_update') {
      updateStoredSessionInfo(process, update);
      return [];
    }
    if (sessionUpdate === 'usage_update') {
      // v16.1.13 新增：每轮结束时 agent 下发上下文用量与可选费用。
      // 桌面端把它转成 usage_update 事件，由渲染层在右栏 Agent 状态区展示，不进消息流。
      return [{ sessionId, type: 'usage_update', message: getUsageMessage(update), payload: params }];
    }

    return [];
  };

  const handleNotification = (process: AcpProcessState, message: JsonRpcNotification) => {
    if (message.method !== 'session/update') {
      return;
    }

    mapSessionUpdate(process, message.params as SessionNotification).forEach((event) => {
      if (process.isReplaying && isReplayMessageEvent(event)) {
        if (process.replayMode === 'buffer') {
          process.replayEvents.push(event);
        }
        return;
      }
      emitEvent(event);
    });
  };

  const handlePermissionRequest = (process: AcpProcessState, message: JsonRpcRequest) => {
    const requestId = `${process.localSessionId}-${String(message.id)}`;
    const params = isRecord(message.params) ? message.params : {};
    const options = normalizePermissionOptions(params.options);
    pendingPermissions.set(requestId, { process, rpcId: message.id, options });
    addLog(process.localSessionId, 'permission', getPermissionMessage(params));
    sendAgentEvent({
      sessionId: process.localSessionId,
      type: 'permission_request',
      message: getPermissionMessage(params),
      payload: { ...params, requestId, options }
    });
  };

  // ACP elicitation/create：omp 第2层审批门控（ExtensionToolWrapper）在 always-ask/write
  // 模式下通过此通道向客户端请求表单确认（如 Approve/Deny）。
  // params 形如 { mode: 'form', message, requestedSchema: { properties: { value: {...} }, required } }。
  const loadElicitationPlanPreview = async (
    process: AcpProcessState,
    requestId: string,
    message: string
  ) => {
    try {
      const fullPlan = await readFullPlanForApproval(process);
      const pending = pendingElicitations.get(requestId);
      // 读取期间请求可能已被响应、取消或随进程关闭；失效后不再补发预览。
      if (
        !fullPlan ||
        pending?.process !== process ||
        process.closed ||
        process.suppressCloseEvent ||
        agentProcesses.get(process.localSessionId) !== process
      ) {
        // fullPlan 为空的原因已在 readFullPlanForApproval 内部记录；这里只记录补发被丢弃的运行时失效。
        if (fullPlan) {
          const reasons: string[] = [];
          if (pending?.process !== process) reasons.push('请求已被响应或替换');
          if (process.closed) reasons.push('进程已关闭');
          if (process.suppressCloseEvent) reasons.push('进程切换中');
          if (agentProcesses.get(process.localSessionId) !== process) reasons.push('进程已被新实例替换');
          addLog(process.localSessionId, 'info', `[plan-preview] 完整方案已读到但补发被丢弃（${reasons.join('；') || '未知失效'}），requestId=${requestId}`);
        }
        return;
      }
      sendAgentEvent({
        sessionId: process.localSessionId,
        type: 'elicitation_plan_preview',
        message: '完整方案已加载',
        payload: { requestId, fullPlan }
      });
    } catch (error) {
      const message2 = error instanceof Error ? error.message : '未知原因';
      try {
        addLog(process.localSessionId, 'error', `完整方案读取失败：${message2}`);
      } catch (logError) {
        console.error('完整方案读取失败，且日志写入失败', error, logError);
      }
    }
  };

  const handleElicitationRequest = (process: AcpProcessState, message: JsonRpcRequest) => {
    const requestId = `${process.localSessionId}-${String(message.id)}`;
    const params = isRecord(message.params) ? message.params : {};
    const message2 = typeof params.message === 'string' ? params.message : 'agent 请求输入';
    const requestedSchema = isRecord(params.requestedSchema) ? params.requestedSchema : {};
    const questionnaire = parseQuestionnaireEval(message2) ?? undefined;
    pendingElicitations.set(requestId, { process, rpcId: message.id, questionnaire });
    addLog(process.localSessionId, 'permission', message2);
    sendAgentEvent({
      sessionId: process.localSessionId,
      type: questionnaire ? 'questionnaire_request' : 'elicitation_request',
      message: message2,
      payload: {
        ...params,
        requestId,
        message: message2,
        requestedSchema,
        ...(questionnaire ? { questionnaire } : {})
      }
    });
    if (!questionnaire) {
      void loadElicitationPlanPreview(process, requestId, message2);
    }
  };

  const handleRequest = (process: AcpProcessState, message: JsonRpcRequest) => {
    if (message.method === 'session/request_permission') {
      handlePermissionRequest(process, message);
      return;
    }
    if (message.method === 'elicitation/create') {
      handleElicitationRequest(process, message);
      return;
    }

    sendErrorResponse(process, message.id, -32601, `未支持的 ACP client 方法：${message.method}`);
  };

  const handleLine = (process: AcpProcessState, line: string, isError = false) => {
    if (isError) {
      emitEvent({ sessionId: process.localSessionId, type: 'error', message: line });
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      emitEvent({ sessionId: process.localSessionId, type: 'output', message: line });
      return;
    }

    // stdout 中的每一行都是 JSON-RPC 消息，需按响应、请求、通知分别处理。
    if (isJsonRpcResponse(message)) {
      handleResponse(process, message);
      return;
    }
    if (isJsonRpcRequest(message)) {
      handleRequest(process, message);
      return;
    }
    if (isJsonRpcNotification(message)) {
      handleNotification(process, message);
      return;
    }

    emitEvent({ sessionId: process.localSessionId, type: 'output', message: stringifySafe(message) });
  };

  const handleChunk = (process: AcpProcessState, chunk: Buffer, isError = false) => {
    process.lineBuffer += chunk.toString();
    const lines = process.lineBuffer.split(/\r?\n/);
    process.lineBuffer = lines.pop() ?? '';

    lines
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => handleLine(process, line, isError));
  };

  const initializeAcp = async (process: AcpProcessState) => {
    const initResult = await sendRequest(process, 'initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: {
        name: 'oh-my-pi-desktop',
        title: 'Oh My Pi Desktop',
        version: CLIENT_VERSION
      },
      // 声明 elicitation.form 能力：omp 内置的 ExtensionToolWrapper 第2层审批门控
      // 在 always-ask/write 模式下会走 unstable_createElicitation（form 模式）请求用户确认，
      // 不声明该能力时 omp 的 uiContext.select 会直接返回 undefined，工具被判定为 denied。
      clientCapabilities: {
        elicitation: { form: {} },
        // 支持按计划 ID 更新和移除；未声明时 agent 不会发送 plan_update / plan_removed。
        plan: {}
      }
    });

    if (isRecord(initResult) && Array.isArray(initResult.authMethods)) {
      const hasAgentAuth = initResult.authMethods.some((method) => {
        return isRecord(method) && method.id === 'agent';
      });
      if (hasAgentAuth) {
        await sendRequest(process, 'authenticate', { methodId: 'agent' });
      }
    }

    addLog(process.localSessionId, 'info', 'ACP 初始化完成');
  };

  const methodLabel = (method: AcpProcessState['initMethod']) => {
    if (method === 'session/resume') {
      return '恢复';
    }
    if (method === 'unstable_session/fork') {
      return 'fork';
    }
    return '加载';
  };

  const emitActivePlanUpdate = (process: AcpProcessState, response: unknown) => {
    const planMode = getAcpActivePlan(response);
    if (!planMode) return;
    emitEvent({
      sessionId: process.localSessionId,
      type: 'active_plan_update',
      message: planMode.active ? '当前存在未完成方案' : '当前没有未完成方案',
      // 这里只同步展示状态，不携带或恢复任何已经失效的 elicitation requestId。
      payload: planMode
    });
  };

  const restoreAcpSession = async (
    process: AcpProcessState,
    acpSessionId: string,
    method: AcpProcessState['initMethod']
  ) => {
    // 标记重放窗口：sendRequest 期间 omp 会通过 session/update 把历史消息流回来。
    // load/fork 先缓存聊天事件，resume 仅用于刷新配置，直接丢弃聊天事件。
    const shouldBufferReplay = method === 'session/load' || method === 'unstable_session/fork';
    process.isReplaying = true;
    process.replayMode = shouldBufferReplay ? 'buffer' : 'suppress';
    process.replayEvents = [];
    let response: unknown;
    let replayEvents: AgentEvent[] = [];
    try {
      response = await sendRequest(process, method, {
        sessionId: acpSessionId,
        cwd: process.workspacePath,
        mcpServers: []
      });
      replayEvents = process.replayEvents;
    } finally {
      process.isReplaying = false;
      process.replayMode = undefined;
      process.replayEvents = [];
    }
    if (method === 'unstable_session/fork') {
      // fork 返回新 sessionId，刷新本地记录；load/resume 沿用原 id。
      if (!isRecord(response) || typeof response.sessionId !== 'string') {
        throw new Error('unstable_session/fork 未返回有效 sessionId');
      }
      copyToolModelSnapshots(acpSessionId, response.sessionId);
      process.acpSessionId = response.sessionId;
    } else {
      process.acpSessionId = acpSessionId;
    }
    if (isRecord(response)) {
      updateConfigOptions(process, response.configOptions);
    }
    const session = upsertSession(
      process.workspacePath,
      process.localSessionId,
      process.localSessionTitle,
      process.acpSessionId,
      undefined,
      true, // 仅加载/恢复历史，不置顶；只有发消息时才应置顶。
      process.approvalProfile
    );
    emitEvent({
      sessionId: process.localSessionId,
      type: 'session_update',
      message: `ACP session 已${methodLabel(method)}`,
      payload: { session }
    });
    if (shouldBufferReplay) {
      const plans = await readHistoricalSessionPlans(process, replayEvents);
      emitEvent({
        sessionId: process.localSessionId,
        type: 'history_loaded',
        message: `历史消息已加载：${replayEvents.length} 条`,
        payload: { events: replayEvents, plans }
      });
    }
    emitActivePlanUpdate(process, response);
    addLog(process.localSessionId, 'info', `ACP session 已${methodLabel(method)}：${process.acpSessionId}`);
    return process.acpSessionId;
  };

  // 确保该子进程已经有一个可用的 ACP session。
  // 已存在则直接返回；否则按 `initMethod` 决定用 load/resume/fork 恢复（带 replay），
  // 或回退到 session/new 新建。
  const ensureAcpSession = async (process: AcpProcessState, suppressConfigEvent?: boolean) => {
    await process.ready;
    if (process.acpSessionId) {
      return process.acpSessionId;
    }

    if (process.restoredAcpSessionId) {
      return restoreAcpSession(process, process.restoredAcpSessionId, process.initMethod);
    }

    const response = await sendRequest(process, 'session/new', {
      cwd: process.workspacePath,
      mcpServers: []
    });
    if (!isRecord(response) || typeof response.sessionId !== 'string') {
      throw new Error('ACP session/new 未返回有效 sessionId');
    }

    process.acpSessionId = response.sessionId;
    // 抑制中间态 config 事件：当 setSessionConfigOption 即将立即覆盖配置时，
    // 避免 session/new 的默认配置事件异步到达渲染端后覆盖用户已选值。
    if (suppressConfigEvent) {
      process.configOptions = normalizeConfigOptions(response.configOptions);
      updateProjectConfigCache(process.workspacePath, process.configOptions);
    } else {
      updateConfigOptions(process, response.configOptions);
    }
    upsertSession(
      process.workspacePath,
      process.localSessionId,
      process.localSessionTitle,
      response.sessionId,
      undefined,
      false,
      process.approvalProfile
    );
    emitActivePlanUpdate(process, response);
    addLog(process.localSessionId, 'info', `ACP session 已创建：${response.sessionId}`);
    return response.sessionId;
  };

  const bindAgentProcess = (process: AcpProcessState) => {
    process.child.stdout.on('data', (chunk: Buffer) => {
      if (!process.suppressCloseEvent) {
        handleChunk(process, chunk);
      }
    });
    process.child.stderr.on('data', (chunk: Buffer) => {
      if (!process.suppressCloseEvent) {
        handleChunk(process, chunk, true);
      }
    });
    process.child.on('error', (error) => {
      process.closed = true;
      process.questionnaireFollowUps = [];
      if (process.suppressCloseEvent) {
        return;
      }
      emitEvent({ sessionId: process.localSessionId, type: 'error', message: error.message });
    });
    process.child.on('close', (code) => {
      process.closed = true;
      agentProcesses.delete(process.localSessionId);
      process.questionnaireFollowUps = [];
      clearPendingPermissionsForProcess(process);
      clearPendingElicitationsForProcess(process);
      if (!process.suppressCloseEvent && process.lineBuffer.trim()) {
        handleLine(process, process.lineBuffer.trim());
        process.lineBuffer = '';
      }
      process.pendingRequests.forEach((pending) => pending.reject(new Error('ACP 进程已退出')));
      process.pendingRequests.clear();
      if (process.suppressCloseEvent) {
        return;
      }
      const message = code === 0 ? 'agent 已完成' : `agent 已退出，代码 ${code ?? 'unknown'}`;
      emitEvent({ sessionId: process.localSessionId, type: code === 0 ? 'done' : 'error', message });
    });
  };

  const startAgent = async (
    sessionId: string,
    workspacePath: string,
    approvalProfile?: ApprovalProfile
  ) => {
    if (agentProcesses.has(sessionId)) {
      return { ok: true, message: 'agent 已在运行' };
    }

    const ompExecutable = getSetting('ompExecutablePath') || 'omp';
    const args = approvalProfile
      ? ['acp', '--approval-mode', approvalProfile]
      : ['acp'];
    const child = spawn(ompExecutable, args, {
      cwd: workspacePath,
      env: { ...process.env, OMP_WORKSPACE: workspacePath }
    });
    const storedSession = readState().recentSessions.find((session) => session.id === sessionId);

    const processState: AcpProcessState = {
      child,
      localSessionId: sessionId,
      localSessionTitle: storedSession?.title ?? '新的 agent 会话',
      workspacePath,
      lineBuffer: '',
      nextRequestId: 1,
      pendingRequests: new Map(),
      ready: Promise.resolve(),
      restoredAcpSessionId: storedSession?.acpSessionId,
      approvalProfile,
      initMethod: 'session/load',
      configOptions: [],
      availableCommands: [],
      closed: false,
      isReplaying: false,
      replayEvents: [],
      turnActive: false,
      questionnaireFollowUps: []
    };
    agentProcesses.set(sessionId, processState);
    bindAgentProcess(processState);
    processState.ready = initializeAcp(processState);
    addLog(
      sessionId,
      'info',
      approvalProfile ? `已启动 omp acp，审批档位：${approvalProfile}` : '已启动 omp acp 临时进程'
    );

    try {
      await processState.ready;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ACP 初始化失败';
      agentProcesses.delete(sessionId);
      processState.suppressCloseEvent = true;
      processState.child.kill();
      emitEvent({ sessionId, type: 'error', message });
      return { ok: false, message };
    }

    return { ok: true, message: 'agent 启动中' };
  };

  // 解析 dataURL "data:<mime>;base64,<data>" -> { mimeType, data }。
  // 解析失败时返回 null，调用方应跳过。
  const parseDataUrl = (dataUrl: string): { mimeType: string; data: string } | null => {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) {
      return null;
    }
    return { mimeType: match[1], data: match[2] };
  };

  // 构造 session/prompt 的 prompt 数组：
  //  - 用户文本 + 文本类附件（解码后追加，带文件名标注）合并成一个 text 块
  //  - 图片类附件、不支持类附件都走 image 块（不支持类让 omp 兜底成占位符）
  const buildPromptBlocks = (content: AgentPromptContent) => {
    const blocks: Array<Record<string, unknown>> = [];
    // 汇总所有要拼进 text 块的文本片段（用户输入 + 文本类附件内容）。
    const textParts: string[] = [];
    if (content.text) {
      textParts.push(content.text);
    }
    (content.attachments ?? []).forEach((attachment) => {
      const parsed = parseDataUrl(attachment.dataUrl);
      if (!parsed) {
        return;
      }
      if (attachment.kind === 'text') {
        // 文本类附件：base64 解码成字符串，带文件名标注拼进 text。
        // omp 会把 text part 原样送进模型，因此模型能读到内容。
        try {
          const decoded = Buffer.from(parsed.data, 'base64').toString('utf8');
          textParts.push(`\n\n[附件：${attachment.fileName ?? '未命名'}]\n${decoded}`);
        } catch {
          // 解码失败时降级为 image 块，让 omp 兜底处理。
          blocks.push({ type: 'image', mimeType: parsed.mimeType, data: parsed.data });
        }
      } else {
        // image 与 unsupported 都走 image 块：
        //  - image：omp 直接让模型看到图片
        //  - unsupported：omp 识别为非图片 mimeType，兜底成 `[embedded resource: <uri>]` 占位符
        blocks.push({ type: 'image', mimeType: parsed.mimeType, data: parsed.data });
      }
    });
    if (textParts.length > 0) {
      blocks.unshift({ type: 'text', text: textParts.join('') });
    }
    return blocks;
  };

  // 防御：当已存在子进程的 workspacePath 与本次请求不一致时，杀掉旧进程并用新 cwd 重启。
  // 触发场景：渲染层因闭包/快速切换把旧项目的 sessionId 误传到新项目下——
  // 不重启的话 session/new 会沿用旧 cwd，agent 仍跑在旧目录。
  const restartAgentForWorkspace = async (
    sessionId: string,
    workspacePath: string,
    approvalProfile: ApprovalProfile
  ) => {
    stopSessionProcess(sessionId);
    const result = await startAgent(sessionId, workspacePath, approvalProfile);
    if (!result.ok) {
      return undefined;
    }
    return agentProcesses.get(sessionId);
  };

  const sendAgentMessage = async (
    sessionId: string,
    workspacePath: string,
    content: AgentPromptContent,
    options: { preserveSessionTitle?: boolean } = {}
  ) => {
    let processState = agentProcesses.get(sessionId);
    // 已有进程但 cwd 不一致：重启，确保后续 session/new 用的是当前 workspacePath。
    if (processState && !processState.closed && processState.workspacePath !== workspacePath) {
      addLog(
        sessionId,
        'info',
        `执行目录切换（${processState.workspacePath} → ${workspacePath}），重启 agent 子进程`
      );
      processState = (
        await restartAgentForWorkspace(
          sessionId,
          workspacePath,
          processState.approvalProfile ?? getStoredApprovalProfile(sessionId)
        )
      ) ?? undefined;
    }
    if (!processState) {
      const result = await startAgent(sessionId, workspacePath, getStoredApprovalProfile(sessionId));
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      processState = agentProcesses.get(sessionId);
    }

    if (!processState || processState.closed) {
      return { ok: false, message: 'ACP 进程不可用' };
    }

    let acpSessionId: string;
    try {
      acpSessionId = await ensureAcpSession(processState);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ACP session 创建失败';
      if (!processState.suppressCloseEvent) {
        emitEvent({ sessionId, type: 'error', message });
      }
      return { ok: false, message };
    }
    const promptBlocks = buildPromptBlocks(content);
    if (promptBlocks.length === 0) {
      return { ok: false, message: '没有可发送的内容' };
    }
    processState.turnActive = true;
    const promptRequest = sendRequest(processState, 'session/prompt', {
      sessionId: acpSessionId,
      prompt: promptBlocks
    });
    promptRequest.then(
      (response) => {
        processState.turnActive = false;
        if (processState.suppressCloseEvent) {
          return;
        }
        const stopReason = isRecord(response) && typeof response.stopReason === 'string' ? response.stopReason : 'end_turn';
        emitEvent({ sessionId, type: 'done', message: `agent 回合结束：${stopReason}`, payload: response });
        void dispatchQuestionnaireFollowUp(processState);
      },
      (error: Error) => {
        processState.turnActive = false;
        if (processState.suppressCloseEvent) {
          return;
        }
        emitEvent({ sessionId, type: 'error', message: error.message });
      }
    );

    if (!options.preserveSessionTitle) {
      upsertSession(
        workspacePath,
        sessionId,
        content.text.slice(0, 42) || '新的 agent 会话',
        processState.acpSessionId,
        undefined,
        false,
        processState.approvalProfile
      );
    }
    addLog(sessionId, 'info', `用户：${content.text}`);
    return { ok: true };
  };

  // 每次只续发一条。若同一会话连续出现问卷，下一条会等待续发回合结束，绝不打断它。
  const dispatchQuestionnaireFollowUp = async (process: AcpProcessState) => {
    if (process.closed || process.suppressCloseEvent || agentProcesses.get(process.localSessionId) !== process) {
      process.questionnaireFollowUps = [];
      return;
    }
    const followUp = process.questionnaireFollowUps.shift();
    if (!followUp) return;
    emitEvent({
      sessionId: process.localSessionId,
      type: 'user_message',
      message: followUp.text,
      payload: { questionnaireRequestId: followUp.requestId }
    });
    const result = await sendAgentMessage(
      process.localSessionId,
      process.workspacePath,
      { text: followUp.text },
      { preserveSessionTitle: true }
    );
    if (!result.ok) {
      emitEvent({
        sessionId: process.localSessionId,
        type: 'error',
        message: result.message ?? '问卷答案续发失败',
        payload: { questionnaireRequestId: followUp.requestId }
      });
      return;
    }
    emitEvent({
      sessionId: process.localSessionId,
      type: 'status_update',
      message: '已将问卷答案发送给 agent，正在继续生成计划',
      payload: { questionnaireRequestId: followUp.requestId, questionnaireFollowUp: true }
    });
  };

  const getProcessWithSession = async (sessionId: string, workspacePath: string, suppressConfigEvent?: boolean) => {
    let processState = agentProcesses.get(sessionId);
    // 与 sendAgentMessage 同样的防御：cwd 不一致就重启，避免 set_config_option 等操作落到旧目录。
    if (processState && !processState.closed && processState.workspacePath !== workspacePath) {
      addLog(
        sessionId,
        'info',
        `执行目录切换（${processState.workspacePath} → ${workspacePath}），重启 agent 子进程`
      );
      processState = (
        await restartAgentForWorkspace(
          sessionId,
          workspacePath,
          processState.approvalProfile ?? getStoredApprovalProfile(sessionId)
        )
      ) ?? undefined;
    }
    if (!processState) {
      const result = await startAgent(sessionId, workspacePath, getStoredApprovalProfile(sessionId));
      if (!result.ok) {
        throw new Error(result.message);
      }
      processState = agentProcesses.get(sessionId);
    }

    if (!processState || processState.closed) {
      throw new Error('ACP 进程不可用');
    }

    await ensureAcpSession(processState, suppressConfigEvent);
    return processState;
  };

  // 纯读取已运行子进程当前缓存的 configOptions：绝不为读取配置而 spawn 进程或新建 session。
  // 配合"首次发消息才真正建 omp 会话"——草稿会话在发出首条消息前不应产生空的 omp 会话；
  // session 真正建立（new/load/resume/fork）后，configOptions 会通过 config_update 事件推给渲染端。
  const getSessionConfig = async (sessionId: string, _workspacePath: string) => {
    const processState = agentProcesses.get(sessionId);
    if (!processState || processState.closed || !processState.acpSessionId) {
      return { ok: true, configOptions: [] };
    }
    return { ok: true, configOptions: processState.configOptions };
  };

  // session 级 config：value 可以是字符串（select option）或布尔（boolean config）。
  // ACP SetSessionConfigOptionRequest.value 的类型就是 string | boolean，
  // 此前桌面端只允许 string，boolean 会被上游拒绝，现在两种值都透传。
  const setSessionConfigOption = async (
    sessionId: string,
    workspacePath: string,
    configId: string,
    value: string | boolean
  ) => {
    try {
      // 检测是否即将创建全新的 ACP session（无现有会话、无恢复目标）。
      // 此时 session/new 会下发默认配置，但我们紧接着就要 set_config_option，
      // 中间态的 config_update 事件如果异步到达渲染端会覆盖用户选择，需要抑制。
      const existingProcess = agentProcesses.get(sessionId);
      const isNewSession =
        !existingProcess || (!existingProcess.acpSessionId && !existingProcess.restoredAcpSessionId);
      const processState = await getProcessWithSession(sessionId, workspacePath, isNewSession);
      if (!processState.acpSessionId) {
        throw new Error('ACP session 尚未创建');
      }

      const response = await sendRequest(processState, 'session/set_config_option', {
        sessionId: processState.acpSessionId,
        configId,
        value
      });
      if (isRecord(response)) {
        updateConfigOptions(processState, response.configOptions);
      }
      return { ok: true, configOptions: processState.configOptions };
    } catch (error) {
      const message = error instanceof Error ? error.message : '设置 ACP 配置失败';
      emitEvent({ sessionId, type: 'error', message });
      return { ok: false, message };
    }
  };

  const cancelTurn = async (sessionId: string) => {
    const processState = agentProcesses.get(sessionId);
    if (!processState || processState.closed || !processState.acpSessionId) {
      return { ok: false, message: '没有可取消的 ACP 回合' };
    }

    cancelPendingPermissionsForProcess(processState);
    cancelPendingElicitationsForProcess(processState);
    processState.questionnaireFollowUps = [];
    writeMessage(processState, {
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: processState.acpSessionId }
    });
    emitEvent({ sessionId, type: 'status_update', message: '已请求取消当前回合' });
    return { ok: true };
  };

  const respondPermission = (requestId: string, allow: boolean) => {
    const pending = pendingPermissions.get(requestId);
    if (!pending) {
      return { ok: false, message: '审批请求已失效' };
    }

    const option = pending.options.find((item) => {
      return item.kind.startsWith(allow ? 'allow' : 'reject');
    });
    const outcome =
      option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };

    sendResponse(pending.process, pending.rpcId, outcome);
    pendingPermissions.delete(requestId);
    return { ok: true };
  };

  const respondPermissionOption = (requestId: string, optionId: string) => {
    const pending = pendingPermissions.get(requestId);
    if (!pending) {
      return { ok: false, message: '审批请求已失效' };
    }

    const selectedOption = pending.options.find((option) => option.optionId === optionId);
    if (!selectedOption) {
      return { ok: false, message: '未知的审批选项' };
    }

    // 只回传该 pending 请求中实际匹配到的 optionId，避免 UI 陈旧值串到其它并发审批请求。
    sendResponse(pending.process, pending.rpcId, {
      outcome: { outcome: 'selected', optionId: selectedOption.optionId }
    });
    pendingPermissions.delete(requestId);
    addLog(
      pending.process.localSessionId,
      'permission',
      `审批响应：${selectedOption.kind} (${selectedOption.optionId})`
    );
    return { ok: true };
  };

  // elicitation 响应：action 为 'accept'（携带 content）/ 'decline' / 'cancel'。
  // content 形如 { value: <用户输入> }，对应 requestedSchema.properties.value。
  const respondElicitation = (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ) => {
    const pending = pendingElicitations.get(requestId);
    if (!pending) {
      return { ok: false, message: '输入请求已失效' };
    }

    const result =
      action === 'accept' && content
        ? { action: 'accept', content }
        : { action };
    sendResponse(pending.process, pending.rpcId, result);
    pendingElicitations.delete(requestId);
    addLog(pending.process.localSessionId, 'permission', `输入响应：${action}`);
    return { ok: true };
  };

  // 问卷提交等同于批准该条严格识别的 eval；真实答案在当前回合结束后再作为用户消息续发。
  const respondQuestionnaire = (
    requestId: string,
    action: 'submit' | 'deny',
    answers?: QuestionnaireAnswer[]
  ): QuestionnaireResponseResult => {
    const pending = pendingElicitations.get(requestId);
    if (!pending?.questionnaire) {
      return { ok: false, message: '问卷请求已失效', reason: 'stale' };
    }
    if (action === 'deny') {
      sendResponse(pending.process, pending.rpcId, { action: 'accept', content: { value: 'Deny' } });
      pendingElicitations.delete(requestId);
      addLog(pending.process.localSessionId, 'permission', '问卷已拒绝');
      return { ok: true };
    }

    const validated = validateQuestionnaireAnswers(pending.questionnaire, answers);
    if (!validated) {
      return { ok: false, message: '问卷答案无效，请重新选择', reason: 'invalid-answers' };
    }
    // 必须先登记续发内容，再放行 eval，避免 ACP 极快结束时丢失用户答案。
    pending.process.questionnaireFollowUps.push({
      requestId,
      text: formatQuestionnaireFollowUp(pending.questionnaire, validated)
    });
    sendResponse(pending.process, pending.rpcId, { action: 'accept', content: { value: 'Approve' } });
    pendingElicitations.delete(requestId);
    addLog(pending.process.localSessionId, 'permission', '问卷已提交，等待当前回合结束后续发答案');
    return { ok: true };
  };

  // 杀掉指定 session 的子进程并清空其 pending 状态。
  const stopSessionProcess = (localSessionId: string) => {
    const processState = agentProcesses.get(localSessionId);
    if (!processState) {
      return;
    }
    processState.suppressCloseEvent = true;
    processState.child.kill();
    agentProcesses.delete(localSessionId);
    processState.questionnaireFollowUps = [];
    clearPendingPermissionsForProcess(processState);
    clearPendingElicitationsForProcess(processState);
  };

  // 拉取 agent 在指定 workspace 下保存的所有 session（ACP session/list）。
  // 若该 workspace 已有运行的子进程，优先复用其进程发送请求；否则启动一个临时子进程。
  const listSessions = async (workspacePath: string, cursor?: string): Promise<ListSessionsResult> => {
    let processState = agentProcesses.get(`__list__${workspacePath}`);
    if (!processState || processState.closed) {
      // 临时子进程：用一个虚拟 localSessionId，完成后调用方通过 stopSessionProcess 杀掉。
      const tempId = `__list__${workspacePath}`;
      const started = await startAgent(tempId, workspacePath);
      if (!started.ok) {
        return { ok: false, message: started.message };
      }
      processState = agentProcesses.get(tempId);
    }
    if (!processState) {
      return { ok: false, message: '临时 agent 进程不可用' };
    }

    try {
      const response = await sendRequest(processState, 'session/list', {
        cwd: workspacePath,
        cursor: cursor ?? null
      });
      if (!isRecord(response)) {
        return { ok: false, message: 'session/list 返回结构无效' };
      }
      const items = Array.isArray(response.sessions) ? response.sessions : [];
      const sessions = items.flatMap((item) => {
        if (!isRecord(item) || typeof item.sessionId !== 'string' || typeof item.cwd !== 'string') {
          return [];
        }
        return [
          {
            sessionId: item.sessionId,
            cwd: item.cwd,
            title: typeof item.title === 'string' ? item.title : undefined,
            updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : undefined
          }
        ];
      });
      return {
        ok: true,
        sessions,
        nextCursor: typeof response.nextCursor === 'string' ? response.nextCursor : undefined
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'session/list 调用失败';
      return { ok: false, message };
    }
  };

  // 通用：把一个已存在的 acpSessionId 装入本地 AcpProcessState 并立即恢复/克隆。
  // 优先复用已存在子进程；否则启动一个，设好 restoredAcpSessionId/initMethod 后主动调
  // ensureAcpSession 真正执行 session/load｜resume｜fork（会发出 replay 通知）。
  // 之前依赖 getSessionConfig 的副作用触发，现 getSessionConfig 已改纯读取，必须在此 eager 触发。
  const attachToAcpSession = async (
    localSessionId: string,
    workspacePath: string,
    acpSessionId: string,
    initMethod: 'session/load' | 'session/resume' | 'unstable_session/fork',
    approvalProfile: ApprovalProfile
  ): Promise<SessionActionResult> => {
    let processState = agentProcesses.get(localSessionId);
    if (processState && !processState.closed && processState.workspacePath !== workspacePath) {
      processState = (
        await restartAgentForWorkspace(localSessionId, workspacePath, approvalProfile)
      ) ?? undefined;
    }
    if (processState?.closed) {
      agentProcesses.delete(localSessionId);
      processState = undefined;
    }
    if (!processState) {
      const started = await startAgent(localSessionId, workspacePath, approvalProfile);
      if (!started.ok) {
        return { ok: false, message: started.message };
      }
      processState = agentProcesses.get(localSessionId);
      if (!processState) {
        return { ok: false, message: 'agent 进程不可用' };
      }
    }
    processState.approvalProfile = approvalProfile;
    // 设好恢复槽位后立即执行：load/resume 沿用原 acpSessionId，fork 返回新的 acpSessionId。
    processState.restoredAcpSessionId = acpSessionId;
    processState.initMethod = initMethod;
    try {
      const resolvedSessionId =
        processState.acpSessionId && initMethod !== 'unstable_session/fork'
          ? await restoreAcpSession(processState, acpSessionId, initMethod)
          : await ensureAcpSession(processState);
      return { ok: true, sessionId: resolvedSessionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ACP session 恢复失败';
      return { ok: false, message };
    }
  };

  const loadSession = (localSessionId: string, workspacePath: string, acpSessionId: string) =>
    attachToAcpSession(
      localSessionId,
      workspacePath,
      acpSessionId,
      'session/load',
      getStoredApprovalProfile(localSessionId)
    );

  const resumeSession = (localSessionId: string, workspacePath: string, acpSessionId: string) =>
    attachToAcpSession(
      localSessionId,
      workspacePath,
      acpSessionId,
      'session/resume',
      getStoredApprovalProfile(localSessionId)
    );

  // 启动/切项目时刷新项目配置缓存：恢复已有 session 拿 configOptions，随后释放子进程。
  // 原实现直接使用 localSessionId 作为进程 key，最后 stopSessionProcess 会杀掉用户同期
  // 打开/重放历史的进程，导致 replayHistory 中途中断（历史无法加载）。
  // 修复：改用 __config__${localSessionId} 作为临时进程 key，与用户打开的进程完全隔离；
  // 同时直接发 session/resume 请求（跳过 restoreAcpSession），避免 upsertSession 把假 id
  // 写进会话列表，也避免发出多余的 session_update 事件。
  const refreshSessionConfig = async (localSessionId: string, workspacePath: string, acpSessionId: string) => {
    const tempId = `__config__${localSessionId}`;
    const started = await startAgent(tempId, workspacePath, getStoredApprovalProfile(localSessionId));
    if (!started.ok) {
      return { ok: false, message: started.message };
    }
    const processState = agentProcesses.get(tempId);
    if (!processState) {
      return { ok: false, message: '临时配置子进程不可用' };
    }
    try {
      // 等待 ACP 握手（initialize/authenticate）完成。
      await processState.ready;
      // 直接发 session/resume 取 configOptions，不经 restoreAcpSession，
      // 避免 upsertSession / emitEvent(session_update) 等只属于真实会话的副作用。
      const response = await sendRequest(processState, 'session/resume', {
        sessionId: acpSessionId,
        cwd: workspacePath,
        mcpServers: []
      });
      const configOptions = isRecord(response) ? normalizeConfigOptions(response.configOptions) : [];
      stopSessionProcess(tempId);
      return { ok: true, configOptions };
    } catch (error) {
      stopSessionProcess(tempId);
      const message = error instanceof Error ? error.message : '配置获取失败';
      return { ok: false, message };
    }
  };

  const forkSession = (localSessionId: string, workspacePath: string, sourceAcpSessionId: string) => {
    const sourceSession = readState().recentSessions.find(
      (session) => session.projectPath === workspacePath && session.acpSessionId === sourceAcpSessionId
    );
    return attachToAcpSession(
      localSessionId,
      workspacePath,
      sourceAcpSessionId,
      'unstable_session/fork',
      normalizeApprovalProfile(sourceSession?.approvalProfile)
    );
  };

  // 切换审批档位会重建该会话的 omp acp 进程；ACP mode/config 与消息缓存保持不变。
  const updateApprovalProfile = async (
    sessionId: string,
    workspacePath: string,
    approvalProfile: ApprovalProfile
  ) => {
    const storedSession = readState().recentSessions.find(
      (session) => session.id === sessionId && session.projectPath === workspacePath
    );
    if (!storedSession) {
      return { ok: false, message: '当前会话不存在，请重新打开后再试' };
    }
    let interruptionMessage = '';
    const processState = agentProcesses.get(sessionId);
    if (processState && (processState.turnActive || hasPendingPermissionsForProcess(processState))) {
      try {
        const cancelled = await cancelTurn(sessionId);
        if (cancelled.ok) {
          await waitForTurnToSettle(processState);
          if (processState.turnActive) {
            interruptionMessage = '当前回合未能及时结束，已终止旧运行环境并完成切换';
          }
        } else {
          interruptionMessage = '当前回合未能正常取消，已终止旧运行环境并完成切换';
        }
      } catch (error) {
        addLog(
          sessionId,
          'error',
          `切换审批档位前取消回合失败：${error instanceof Error ? error.message : '未知原因'}`
        );
        interruptionMessage = '当前回合未能正常取消，已终止旧运行环境并完成切换';
      }
    }
    stopSessionProcess(sessionId);

    const session = updateSessionApprovalProfile(sessionId, approvalProfile);
    if (!session) {
      return { ok: false, message: '审批档位保存失败，请重试' };
    }
    if (!session.acpSessionId) {
      return { ok: true, session, message: interruptionMessage || undefined };
    }

    const restored = await attachToAcpSession(
      sessionId,
      workspacePath,
      session.acpSessionId,
      'session/resume',
      approvalProfile
    );
    if (!restored.ok) {
      addLog(
        sessionId,
        'error',
        `审批档位已保存，但运行环境恢复失败：${restored.message ?? '未知原因'}`
      );
      stopSessionProcess(sessionId);
      return {
        ok: false,
        session,
        message: '审批档位已保存，但运行环境恢复失败，可重试'
      };
    }
    return { ok: true, session, message: interruptionMessage || undefined };
  };

  // 关闭 session（向 agent 发 session/close），并杀掉本地子进程释放资源。
  const closeSession = (localSessionId: string): SessionActionResult => {
    const processState = agentProcesses.get(localSessionId);
    if (!processState || !processState.acpSessionId) {
      return { ok: false, message: 'session 不可用' };
    }
    try {
      writeMessage(processState, {
        jsonrpc: '2.0',
        method: 'session/close',
        params: { sessionId: processState.acpSessionId }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'session/close 失败';
      return { ok: false, message };
    }
    processState.suppressCloseEvent = true;
    processState.child.kill();
    agentProcesses.delete(localSessionId);
    processState.questionnaireFollowUps = [];
    clearPendingPermissionsForProcess(processState);
    clearPendingElicitationsForProcess(processState);
    return { ok: true };
  };

  const stopAll = () => {
    agentProcesses.forEach((process) => {
      process.suppressCloseEvent = true;
      process.child.kill();
      process.questionnaireFollowUps = [];
    });
    agentProcesses.clear();
    pendingPermissions.clear();
    pendingElicitations.clear();
  };

  return {
    startAgent,
    sendAgentMessage,
    getSessionConfig,
    setSessionConfigOption,
    updateApprovalProfile,
    cancelTurn,
    respondPermissionOption,
    respondPermission,
    respondElicitation,
    respondQuestionnaire,
    listSessions,
    loadSession,
    resumeSession,
    refreshSessionConfig,
    forkSession,
    closeSession,
    stopSessionProcess,
    stopAll
  };
};
