import {
  ClipboardEvent,
  CSSProperties,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { ChatWorkspace } from './components/ChatWorkspace';
import { ContextPane } from './components/ContextPane';
import { ElicitationModal } from './components/ElicitationModal';
import {
  GitBranchSwitchErrorModal,
  resolveGitBranchSwitchFailure,
  type GitBranchSwitchError
} from './components/GitBranchSwitchErrorModal';
import { PermissionModal } from './components/PermissionModal';
import { QuestionnaireModal } from './components/QuestionnaireModal';
import { ProjectPane } from './components/ProjectPane';
import { SessionSearchModal, type SessionSearchItem } from './components/SessionSearchModal';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import type { AcpConfigOption, ChatMessage, ElicitationRequest, PermissionOption, PermissionRequest, QuestionnaireAnswer, QuestionnaireRequest } from './types';
import {
  getElicitationKind,
  getLogLevel,
  getMessageRole,
  getPayloadAvailableCommands,
  getPayloadConfigOptions,
  getPayloadElicitationField,
  getPayloadFullPlan,
  getPayloadQuestionnaire,
  getPayloadMessageId,
  getPayloadPermissionOptions,
  getPayloadPlanChange,
  getPayloadRequestId,
  getPayloadToolCall,
  splitElicitationPlan
} from './utils';
import './styles.css';

// 附件大小上限（图片 / 文本 / 其它统一 8MB）。dataURL 是 base64，长度约为原文件 ×4/3。
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const LEFT_PANE_DEFAULT_WIDTH = 280;
const LEFT_PANE_MIN_WIDTH = 120;
const LEFT_PANE_MAX_WIDTH = 480;
const LEFT_PANE_COLLAPSE_THRESHOLD = 180;
const RIGHT_PANE_DEFAULT_WIDTH = 320;
const RIGHT_PANE_MIN_WIDTH = 180;
const RIGHT_PANE_MAX_WIDTH = 560;
const RIGHT_PANE_COLLAPSE_THRESHOLD = 220;
type PaneSide = 'left' | 'right';
type ReviewSource = 'unstaged' | 'staged';
type DraftConfigValues = Partial<Record<'model' | 'mode' | 'thinking', string>>;
const DEFAULT_APPROVAL_PROFILE: ApprovalProfile = 'write';

// ACP 没有单独的「开始创建计划」事件；通过计划工具标题识别其执行阶段，
// 先插入可见占位卡，收到正式 plan 事件后再替换为完整计划。
const isPlanToolCall = (title: string) => {
  const normalized = title.trim().toLowerCase();
  return (
    normalized.includes('update_plan') ||
    /\b(create|creating|update|updating|write|writing)\s+(the\s+)?plan\b/.test(normalized) ||
    /(创建|生成|更新|编写|制定).*计划/.test(normalized)
  );
};

// 待发送的附件。kind 决定发送时走哪种 ACP 块（见主进程 buildPromptBlocks）：
//  - image:       omp 能让模型看到（base64 图片）
//  - text:        base64 解码后追加到 text 块，omp 能让模型看到
//  - unsupported: 仍发送，但 omp 会兜底成占位符，模型读不到内容（chip 上标警告）
type PendingAttachment = {
  dataUrl: string;
  fileName: string;
  kind: 'image' | 'text' | 'unsupported';
};

// 文本类附件扩展名清单：命中则按 text 处理（解码后拼进 text 块）。
// 未命中且非 image/* 的，按 unsupported 处理。
const TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.json', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.csv', '.log', '.yml', '.yaml', '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.ini', '.conf', '.sh', '.bash', '.bat', '.ps1', '.rs', '.go', '.java', '.c', '.cpp', '.cc',
  '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.sql', '.graphql', '.vue', '.svelte'
];

// 按 MIME + 文件名扩展名判定附件类别。
const classifyAttachment = (file: File): 'image' | 'text' | 'unsupported' => {
  if (file.type.startsWith('image/')) {
    return 'image';
  }
  if (file.type.startsWith('text/')) {
    return 'text';
  }
  const lower = file.name.toLowerCase();
  if (TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return 'text';
  }
  return 'unsupported';
};

// 待执行的 slash 命令卡片：用户按下发送后、omp 真正回包前展示，
// 给"按下发送"与"看到输出"之间一个明确的视觉过渡。
// 按 sessionId 分桶，与 messageCache / permissionBySession / usageBySession 同属多 session 隔离缓存。
type PendingSlashCommand = {
  id: string;
  name: string;
  args: string;
  sentAt: string;
  // 已匹配到的命令元数据（图标 + 说明文案），渲染时直接读，避免每次渲染重新查表。
  icon: string;
  label: string;
};

// 已知 slash 命令的差异化展示元数据。只列几条用户高频命令，
// 不是完整命令清单——命令清单仍由 omp 通过 available_commands_update 下发。
const COMMAND_PENDING_META: Record<string, { icon: string; label: string }> = {
  compact: { icon: '⊜', label: '正在压缩上下文…' },
  model: { icon: '◆', label: '正在切换模型…' },
  mode: { icon: '◐', label: '正在切换模式…' },
  plan: { icon: '□', label: '正在切换 Plan 模式…' },
  'plan-review': { icon: '□', label: '正在打开最近的计划评审…' },
  resume: { icon: '↻', label: '正在同步历史会话…' },
  mcp: { icon: '▦', label: '正在管理 MCP 服务…' }
};
const COMMAND_PENDING_DEFAULT = { icon: '▶', label: '正在执行本地命令…' };
const REVIEW_SOURCE_LABEL: Record<ReviewSource, string> = {
  unstaged: '未暂存',
  staged: '已暂存',
};

// 解析 `/name args` 形式的输入，返回 { name, args }；非 slash 输入返回 null。
// 解析失败的空字符串命令不视为有效命令，避免把普通消息里的 "/" 当成命令。
const parseSlashCommand = (
  text: string
): { name: string; args: string } | null => {
  const match = text.match(/^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
};

// 根据命令名查 COMMAND_PENDING_META，没命中回退到默认值。
const resolveCommandPendingMeta = (name: string): { icon: string; label: string } => {
  return COMMAND_PENDING_META[name] ?? COMMAND_PENDING_DEFAULT;
};

const clampPaneWidth = (value: number, min: number, max: number) => {
  return Math.min(max, Math.max(min, value));
};

const getHistoryLoadedEvents = (payload: unknown): AgentEvent[] => {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const events = (payload as { events?: unknown }).events;
  return Array.isArray(events) ? (events as AgentEvent[]) : [];
};

type HistoricalSessionPlan = {
  id: string;
  toolCallId: string;
  planFilePath: string;
  content: string;
};

type ActiveSessionPlan =
  | { active: false }
  | { active: true; planFilePath: string; content: string | null };

const getHistoryLoadedPlans = (payload: unknown): HistoricalSessionPlan[] => {
  if (!payload || typeof payload !== 'object') return [];
  const plans = (payload as { plans?: unknown }).plans;
  if (!Array.isArray(plans)) return [];
  return plans.filter((plan): plan is HistoricalSessionPlan => (
    typeof plan === 'object' &&
    plan !== null &&
    typeof plan.id === 'string' &&
    typeof plan.toolCallId === 'string' &&
    typeof plan.planFilePath === 'string' &&
    typeof plan.content === 'string'
  ));
};

const insertHistoricalPlans = (
  messages: ChatMessage[],
  plans: HistoricalSessionPlan[]
) => {
  const next = [...messages];
  for (const plan of plans) {
    if (next.some((message) => message.id === plan.id)) continue;
    const planMessage: ChatMessage = {
      id: plan.id,
      role: 'plan',
      text: plan.content,
      planId: plan.id,
      planContentType: 'markdown',
      planFilePath: plan.planFilePath
    };
    const toolIndex = next.findIndex((message) => message.toolCallId === plan.toolCallId);
    if (toolIndex >= 0) {
      next.splice(toolIndex + 1, 0, planMessage);
    } else {
      next.push(planMessage);
    }
  }
  return next;
};

const getActiveSessionPlan = (payload: unknown): ActiveSessionPlan | null => {
  if (!payload || typeof payload !== 'object') return null;
  const plan = payload as Record<string, unknown>;
  if (plan.active === false) return { active: false };
  if (
    plan.active !== true ||
    typeof plan.planFilePath !== 'string' ||
    (typeof plan.content !== 'string' && plan.content !== null)
  ) {
    return null;
  }
  return {
    active: true,
    planFilePath: plan.planFilePath,
    content: plan.content
  };
};

const applyActiveSessionPlan = (messages: ChatMessage[], plan: ActiveSessionPlan) => {
  const withoutPreviousActive = messages.filter((message) => !message.planActive);
  if (!plan.active) return withoutPreviousActive;
  const withoutDuplicate = withoutPreviousActive.filter(
    (message) => !message.planPending && message.planFilePath !== plan.planFilePath
  );
  return [
    ...withoutDuplicate,
    {
      id: 'active-session-plan',
      role: 'plan' as const,
      text: plan.content ?? `方案文件：${plan.planFilePath}\n\n暂时无法读取方案正文。`,
      planId: 'active-session-plan',
      planContentType: 'markdown' as const,
      planActive: true,
      planFilePath: plan.planFilePath,
      // 活跃方案来自 session `_meta`，故意不设置 planPreviewRequestId。
    }
  ];
};

const getElicitationResultText = (
  request: ElicitationRequest,
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown>
) => {
  if (action === 'decline') return '已拒绝';
  if (action === 'cancel') return '已取消';
  const value = content?.value;
  if (value === true) return '已确认';
  if (request.field.options?.length && typeof value === 'string') {
    if (value.endsWith(' Done selecting') || value === 'Done selecting') return '已完成选择';
    return `已选择：${value.replace(/ \(Recommended\)$/, '')}`;
  }
  if (value !== undefined) return `已提交：${String(value)}`;
  return '已提交';
};

const mergeAgentEventIntoMessages = (
  current: ChatMessage[],
  event: AgentEvent,
  currentModel?: ChatMessage['toolModel']
): ChatMessage[] => {
  const messageId = getPayloadMessageId(event.payload);
  const role = getMessageRole(event.type);

  /* 流式文本合并：回答、思考与用户消息按 messageId + role 分别累积，
     避免 omp 复用 messageId 时把思考过程拼进最终回答。 */
  if (messageId && (role === 'agent' || role === 'thought' || role === 'user')) {
    const existing = current.find((message) => message.id === messageId && message.role === role);
    if (existing) {
      return current.map((message) =>
        message.id === messageId && message.role === role
          ? { ...message, text: `${message.text}${event.message}` }
          : message
      );
    }
    return [...current, { id: messageId, role, text: event.message }];
  }

  /* 工具调用：按 toolCallId 去重/更新，携带结构化数据 */
  if (event.type === 'tool_call') {
    const toolData = getPayloadToolCall(event.payload);
    const appendPlanPending = (messages: ChatMessage[]) => {
      const canStartPlan = !toolData.status || toolData.status === 'pending' || toolData.status === 'in_progress';
      if (
        !canStartPlan ||
        !isPlanToolCall(toolData.title || event.message) ||
        messages.some((message) => message.planPending)
      ) {
        return messages;
      }
      return [
        ...messages,
        {
          id: `plan-pending-${toolData.toolCallId || Date.now()}`,
          role: 'plan' as const,
          text: 'Agent 正在整理任务步骤，完成后将在这里展示完整计划。',
          planPending: true
        }
      ];
    };
    const existing = current.find(
      (message) => message.toolCallId && message.toolCallId === toolData.toolCallId
    );
    if (existing) {
      const updated = current.map((message) =>
        message.toolCallId === toolData.toolCallId
          ? {
              ...message,
              text: event.message,
              toolKind: (toolData.kind ?? message.toolKind) as ChatMessage['toolKind'],
              toolStatus: (toolData.status ?? message.toolStatus) as ChatMessage['toolStatus'],
              toolLocations: toolData.locations ?? message.toolLocations,
              toolDiffs: toolData.diffs ?? message.toolDiffs,
              toolOutput: toolData.output ?? message.toolOutput,
              toolModel: toolData.toolModel ?? message.toolModel
            }
          : message
      );
      return appendPlanPending(updated);
    }
    // 仅在实时事件时使用当前模型快照；历史 replay 事件优先使用主进程带回的快照。
    const isReplay =
      typeof event.payload === 'object' &&
      event.payload !== null &&
      (event.payload as Record<string, unknown>)._replay === true;
    const toolModel = toolData.toolModel ?? (!isReplay ? currentModel : undefined);
    return appendPlanPending([
      ...current,
      {
        id: messageId || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role,
        text: event.message,
        toolCallId: toolData.toolCallId,
        toolKind: toolData.kind as ChatMessage['toolKind'],
        toolStatus: toolData.status as ChatMessage['toolStatus'],
        toolLocations: toolData.locations,
        toolDiffs: toolData.diffs,
        toolOutput: toolData.output,
        toolModel
      }
    ]);
  }

  /* 旧 plan 只替换无 ID 的结构化执行清单；方案文档与执行进度是两类信息，必须并存。
     plan_update / plan_removed 仍按 planId 精确更新对应计划。 */
  if (event.type === 'plan') {
    const change = getPayloadPlanChange(event.payload);
    if (!change) return current;
    if (change.action === 'remove') {
      return current.filter((message) => message.role !== 'plan' || message.planId !== change.planId);
    }
    const withoutReplacedPlan = current.filter((message) => {
      if (message.role !== 'plan') return true;
      if (message.planPending) return false;
      if (change.planId) return message.planId !== change.planId;
      return message.planContentType !== 'items' || !!message.planId;
    });
    return [
      ...withoutReplacedPlan,
      {
        id: change.planId ?? `plan-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'plan' as const,
        text: change.text ?? event.message,
        planId: change.planId,
        planContentType: change.contentType,
        planEntries: change.contentType === 'items' ? change.entries : undefined
      }
    ];
  }

  /* Plan 模式占位卡只用于等待正式 plan；回合结束/报错仍未收到 plan 时自动清理。
     同时收敛没有收到 tool_call_update 终态的工具，避免 ACP 取消、进程退出或协议丢包后卡片永久转圈。 */
  if (event.type === 'done' || event.type === 'error') {
    const withoutPendingPlan = current.filter((message) => !message.planPending);
    const payload = event.payload && typeof event.payload === 'object'
      ? event.payload as Record<string, unknown>
      : undefined;
    const stopReason = typeof payload?.stopReason === 'string' ? payload.stopReason : '';
    const unresolvedToolResult = event.type === 'error'
      ? `工具调用因回合错误而中止：${event.message}`
      : stopReason === 'cancelled'
        ? '工具调用已随当前回合取消。'
        : '回合已结束，但未收到工具调用的完成状态。';
    const settledMessages = withoutPendingPlan.map((message) => {
      if (
        message.role !== 'tool' ||
        (message.toolStatus !== undefined && message.toolStatus !== 'pending' && message.toolStatus !== 'in_progress')
      ) {
        return message;
      }
      return {
        ...message,
        toolStatus: 'failed' as const,
        toolOutput: message.toolOutput
          ? `${message.toolOutput}\n\n${unresolvedToolResult}`
          : unresolvedToolResult
      };
    });
    return [
      ...settledMessages,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role,
        text: event.message
      }
    ];
  }

  return [
    ...current,
    {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role,
      text: event.message
    }
  ];
};

export default function App() {
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
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [leftPaneWidth, setLeftPaneWidth] = useState(LEFT_PANE_DEFAULT_WIDTH);
  const [rightPaneWidth, setRightPaneWidth] = useState(RIGHT_PANE_DEFAULT_WIDTH);
  const [resizingSide, setResizingSide] = useState<PaneSide | null>(null);
  const [collapsePreviewSide, setCollapsePreviewSide] = useState<PaneSide | null>(null);
  const [leftPreviewMounted, setLeftPreviewMounted] = useState(false);
  const [leftPreviewOpen, setLeftPreviewOpen] = useState(false);
  // 会话搜索弹窗只承载入口外壳，实际搜索逻辑后续再接入。
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  // 拖拽过程用 ref 记录起点，避免 mousemove 高频触发时依赖 React 异步 state。
  const resizeStateRef = useRef<{
    side: PaneSide;
    startX: number;
    startWidth: number;
    willCollapse: boolean;
  } | null>(null);
  const leftPreviewOpenTimer = useRef<number | null>(null);
  const leftPreviewCloseTimer = useRef<number | null>(null);
  const leftPreviewUnmountTimer = useRef<number | null>(null);
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
  // 工具调用折叠状态：按 sessionId 分桶，key = 「该工具组最后一条 tool 消息的 id」，
  // value = true 表示折叠成摘要卡、false 表示用户主动展开、undefined 表示从未被用户操作过。
  // ChatWorkspace 会把 undefined 也按默认折叠展示；用户主动展开后保持 false 不被覆盖。
  const collapsedToolGroupsBySession = useRef<Record<string, Record<string, boolean | undefined>>>({});
  const [collapsedToolGroupsVersion, setCollapsedToolGroupsVersion] = useState(0);
  const bumpCollapsedToolGroups = () => setCollapsedToolGroupsVersion((value) => value + 1);

  const refreshDiff = useCallback(async (source: ReviewSource, project = selectedProjectRef.current) => {
    const refreshId = diffRefreshIdRef.current + 1;
    diffRefreshIdRef.current = refreshId;
    const sourceLabel = REVIEW_SOURCE_LABEL[source];

    if (!project) {
      setDiffText('');
      setDiffStatus('请选择项目后查看 Git 改动');
      return;
    }

    try {
      setDiffStatus(`正在读取${sourceLabel}改动...`);
      const result = await window.ohMyPiDesktop.getDiff(project.path, source);

      // 用户快速切换项目/来源时，旧请求可能后返回；这里丢弃旧结果，避免右栏显示错项目 diff。
      if (
        refreshId !== diffRefreshIdRef.current ||
        selectedProjectRef.current?.path !== project.path ||
        reviewSourceRef.current !== source
      ) {
        return;
      }

      setDiffText(result.diff);
      if (!result.ok && !result.diff) {
        setDiffStatus(result.message || `读取${sourceLabel}改动失败`);
        return;
      }
      setDiffStatus(result.diff ? `已读取${sourceLabel}改动` : result.message || `当前没有${sourceLabel}改动`);
    } catch (error) {
      if (
        refreshId !== diffRefreshIdRef.current ||
        selectedProjectRef.current?.path !== project.path ||
        reviewSourceRef.current !== source
      ) {
        return;
      }
      setDiffText('');
      setDiffStatus(error instanceof Error ? error.message : `读取${sourceLabel}改动失败`);
      return;
    }
  }, []);

  const refreshGitBranches = useCallback(async (project = selectedProjectRef.current) => {
    const refreshId = branchRefreshIdRef.current + 1;
    branchRefreshIdRef.current = refreshId;
    if (!project) {
      setGitBranches([]);
      setCurrentGitBranch('');
      setGitBranchNotice('');
      return null;
    }

    const result = await window.ohMyPiDesktop.getGitBranches(project.path);
    // 请求序号与项目路径共同防止快速切换项目时，旧仓库的异步结果覆盖当前审查状态。
    if (refreshId !== branchRefreshIdRef.current || selectedProjectRef.current?.path !== project.path) {
      return null;
    }
    setGitBranches(result.branches);
    setCurrentGitBranch(result.currentBranch);
    setGitBranchNotice(result.ok ? '' : result.message);
    if (!result.ok) {
      return null;
    }
    return result.currentBranch;
  }, []);

  const syncGitReview = useCallback(async (project = selectedProjectRef.current) => {
    if (!project) {
      await refreshGitBranches(project);
      return;
    }

    const nextBranch = await refreshGitBranches(project);
    if (nextBranch === null || selectedProjectRef.current?.path !== project.path) {
      return;
    }

    // 外部终端既可能切换分支，也可能改变暂存区或工作区；事件触发时需同步当前来源的 diff。
    // 这里仍是 focus/visibility 驱动而非轮询，不会持续创建 Git 子进程。
    await refreshDiff(reviewSourceRef.current, project);
  }, [refreshDiff, refreshGitBranches]);

  useEffect(() => {
    reviewSourceRef.current = reviewSource;
  }, [reviewSource]);

  useEffect(() => {
    void refreshDiff(reviewSource);
  }, [refreshDiff, reviewSource, selectedProject?.path, selectedSession?.id]);

  useEffect(() => {
    // 切换项目时解除旧项目的分支切换加载态，新项目独立读取自己的分支。
    setSwitchingGitBranch(false);
    void refreshGitBranches(selectedProject);
  }, [refreshGitBranches, selectedProject?.path]);

  // 当前选中 session 的折叠 map：供 ChatWorkspace 通过 props 读取。
  const collapsedToolGroups = useMemo<Record<string, boolean | undefined>>(() => {
    if (!selectedSession) {
      return {};
    }
    return collapsedToolGroupsBySession.current[selectedSession.id] ?? {};
  }, [selectedSession, collapsedToolGroupsVersion]);

  // 在消息流末尾反向扫描「最近一个 user 消息之后」的工具组，返回其中最后一条 tool 消息的 id。
  // 用于 done 时确定本轮工具组的 groupId：所有介于该 user 与末尾之间的 tool 消息视为同一组折叠。
  const findLatestToolGroupId = (list: ChatMessage[]): string | undefined => {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index];
      if (message.role === 'user') {
        // 越过 user 还没找到 tool → 这一轮没有工具调用
        return undefined;
      }
      if (message.role === 'tool') {
        return message.id;
      }
    }
    return undefined;
  };

  // 扫描整条消息流，找出所有「连续 tool 段」的 groupId（每段最后一条 tool 消息的 id），
  // 把未操作（undefined）的组设为 true 折叠。用于打开旧会话（load/resume/fork 重放）后一次性折叠全部工具组。
  const collapseAllToolGroupsForSession = (sessionId: string, messagesForSession?: ChatMessage[]) => {
    const list = messagesForSession ?? messageCache.current[sessionId];
    if (!list || list.length === 0) {
      return;
    }
    // 按消息流顺序遍历，连续 tool 消息归为一段，段内最后一条 tool 消息的 id 即 groupId。
    const groupIds: string[] = [];
    let lastToolId: string | undefined;
    for (const message of list) {
      if (message.role === 'tool') {
        lastToolId = message.id;
      } else {
        if (lastToolId) {
          groupIds.push(lastToolId);
          lastToolId = undefined;
        }
      }
    }
    if (lastToolId) {
      groupIds.push(lastToolId);
    }
    if (groupIds.length === 0) {
      return;
    }
    const bucket = collapsedToolGroupsBySession.current[sessionId] ?? {};
    let changed = false;
    const next = { ...bucket };
    for (const groupId of groupIds) {
      if (next[groupId] === undefined) {
        next[groupId] = true;
        changed = true;
      }
    }
    if (changed) {
      collapsedToolGroupsBySession.current[sessionId] = next;
      bumpCollapsedToolGroups();
    }
  };

  // 清空指定 session 桶里的折叠 map：用于「重置消息流」场景（关闭会话、新建空会话、切项目）。
  const resetCollapsedToolGroupsForSession = (sessionId: string | null | undefined) => {
    if (!sessionId) {
      return;
    }
    if (collapsedToolGroupsBySession.current[sessionId]) {
      delete collapsedToolGroupsBySession.current[sessionId];
      bumpCollapsedToolGroups();
    }
  };

  // 用户点击摘要卡时通知 App 切换折叠状态。
  const handleSetToolGroupCollapsed = (groupId: string, collapsed: boolean) => {
    if (!selectedSession) {
      return;
    }
    const bucket = collapsedToolGroupsBySession.current[selectedSession.id] ?? {};
    if (bucket[groupId] === collapsed) {
      return;
    }
    collapsedToolGroupsBySession.current[selectedSession.id] = { ...bucket, [groupId]: collapsed };
    bumpCollapsedToolGroups();
  };

  const normalizePaneWidth = (side: PaneSide, width: number) => {
    if (side === 'left') {
      return width < LEFT_PANE_COLLAPSE_THRESHOLD
        ? LEFT_PANE_DEFAULT_WIDTH
        : clampPaneWidth(width, LEFT_PANE_MIN_WIDTH, LEFT_PANE_MAX_WIDTH);
    }
    return width < RIGHT_PANE_COLLAPSE_THRESHOLD
      ? RIGHT_PANE_DEFAULT_WIDTH
      : clampPaneWidth(width, RIGHT_PANE_MIN_WIDTH, RIGHT_PANE_MAX_WIDTH);
  };

  const clearLeftPreviewTimers = () => {
    if (leftPreviewOpenTimer.current !== null) {
      window.clearTimeout(leftPreviewOpenTimer.current);
      leftPreviewOpenTimer.current = null;
    }
    if (leftPreviewCloseTimer.current !== null) {
      window.clearTimeout(leftPreviewCloseTimer.current);
      leftPreviewCloseTimer.current = null;
    }
    if (leftPreviewUnmountTimer.current !== null) {
      window.clearTimeout(leftPreviewUnmountTimer.current);
      leftPreviewUnmountTimer.current = null;
    }
  };

  const closeLeftPreview = () => {
    if (!leftPreviewMounted) {
      clearLeftPreviewTimers();
      return;
    }
    clearLeftPreviewTimers();
    setLeftPreviewOpen(false);
    leftPreviewUnmountTimer.current = window.setTimeout(() => {
      setLeftPreviewMounted(false);
      leftPreviewUnmountTimer.current = null;
    }, 180);
  };

  const openLeftPreview = () => {
    if (!leftCollapsed) {
      return;
    }
    clearLeftPreviewTimers();
    setLeftPreviewMounted(true);
    leftPreviewOpenTimer.current = window.setTimeout(() => {
      setLeftPreviewOpen(true);
      leftPreviewOpenTimer.current = null;
    }, 0);
  };

  const openLeftPreviewLater = () => {
    if (leftPreviewCloseTimer.current !== null) {
      window.clearTimeout(leftPreviewCloseTimer.current);
      leftPreviewCloseTimer.current = null;
    }
    if (!leftCollapsed || leftPreviewOpen || leftPreviewOpenTimer.current !== null) {
      return;
    }
    leftPreviewOpenTimer.current = window.setTimeout(() => {
      leftPreviewOpenTimer.current = null;
      openLeftPreview();
    }, 400);
  };

  const keepLeftPreviewOpen = () => {
    if (leftPreviewCloseTimer.current !== null) {
      window.clearTimeout(leftPreviewCloseTimer.current);
      leftPreviewCloseTimer.current = null;
    }
  };

  const closeLeftPreviewLater = () => {
    if (leftPreviewOpenTimer.current !== null) {
      window.clearTimeout(leftPreviewOpenTimer.current);
      leftPreviewOpenTimer.current = null;
    }
    if (leftPreviewCloseTimer.current !== null) {
      window.clearTimeout(leftPreviewCloseTimer.current);
    }
    leftPreviewCloseTimer.current = window.setTimeout(() => {
      leftPreviewCloseTimer.current = null;
      closeLeftPreview();
    }, 200);
  };

  const collapseLeftPane = () => {
    closeLeftPreview();
    setLeftCollapsed(true);
  };

  const expandLeftPane = () => {
    clearLeftPreviewTimers();
    setLeftPreviewOpen(false);
    setLeftPreviewMounted(false);
    setLeftPaneWidth((width) => normalizePaneWidth('left', width));
    setLeftCollapsed(false);
  };

  const toggleLeftPane = () => {
    if (leftCollapsed) {
      expandLeftPane();
      return;
    }
    collapseLeftPane();
  };

  const collapseRightPane = () => {
    setRightCollapsed(true);
  };

  const expandRightPane = () => {
    setRightPaneWidth((width) => normalizePaneWidth('right', width));
    setRightCollapsed(false);
  };

  const toggleRightPane = () => {
    if (rightCollapsed) {
      expandRightPane();
      return;
    }
    collapseRightPane();
  };

  const startPaneResize = (side: PaneSide, event: ReactMouseEvent<HTMLDivElement>) => {
    if ((side === 'left' && leftCollapsed) || (side === 'right' && rightCollapsed)) {
      return;
    }
    event.preventDefault();
    const startWidth = side === 'left' ? leftPaneWidth : rightPaneWidth;
    resizeStateRef.current = {
      side,
      startX: event.clientX,
      startWidth,
      willCollapse: false
    };
    setResizingSide(side);
    setCollapsePreviewSide(null);
  };

  useEffect(() => {
    if (!resizingSide) {
      return;
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (event: MouseEvent) => {
      const state = resizeStateRef.current;
      if (!state) {
        return;
      }
      const delta = event.clientX - state.startX;
      const nextWidth =
        state.side === 'left'
          ? clampPaneWidth(state.startWidth + delta, LEFT_PANE_MIN_WIDTH, LEFT_PANE_MAX_WIDTH)
          : clampPaneWidth(state.startWidth - delta, RIGHT_PANE_MIN_WIDTH, RIGHT_PANE_MAX_WIDTH);
      const willCollapse =
        state.side === 'left'
          ? nextWidth < LEFT_PANE_COLLAPSE_THRESHOLD
          : nextWidth < RIGHT_PANE_COLLAPSE_THRESHOLD;

      state.willCollapse = willCollapse;
      setCollapsePreviewSide(willCollapse ? state.side : null);
      if (state.side === 'left') {
        setLeftPaneWidth(nextWidth);
      } else {
        setRightPaneWidth(nextWidth);
      }
    };

    const handleMouseUp = () => {
      const state = resizeStateRef.current;
      if (state?.willCollapse) {
        if (state.side === 'left') {
          collapseLeftPane();
        } else {
          collapseRightPane();
        }
      }
      resizeStateRef.current = null;
      setResizingSide(null);
      setCollapsePreviewSide(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [resizingSide]);

  useEffect(() => {
    if (!leftCollapsed) {
      clearLeftPreviewTimers();
      setLeftPreviewOpen(false);
      setLeftPreviewMounted(false);
    }
  }, [leftCollapsed]);

  useEffect(() => {
    return () => clearLeftPreviewTimers();
  }, []);

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

  // agent 事件订阅：主进程会把每条 AgentEvent 推过来。
  // 多 session 隔离的关键点：所有事件都带 sessionId，我们按它分发到不同缓存里。
  useEffect(() => {
    return window.ohMyPiDesktop.onAgentEvent((event) => {
      // 把所有事件原样写进 desktopState.logs：日志缓存按 sessionId 自然隔离，
      // 目前仅用于主进程持久化调试，渲染端不再展示基础日志。
      setDesktopState((current) => ({
        ...current,
        logs: [
          {
            id: `${Date.now()}-log-${Math.random().toString(16).slice(2)}`,
            sessionId: event.sessionId,
            level: getLogLevel(event.type),
            message: event.message,
            createdAt: new Date().toISOString()
          },
          ...current.logs
        ].slice(0, 120)
      }));

      // messages 与 permissionRequest 必须按 sessionId 分桶：
      // 1) 当前 session 的事件：直接更新当前 state；
      // 2) 其它 session 的事件：只更新对应缓存（messageCache / permissionBySession），
      //    等用户切回该 session 时由 handleSelectSession 还原。
      if (event.type === 'permission_request') {
        const req: PermissionRequest = {
          requestId: getPayloadRequestId(event.payload),
          message: event.message,
          options: getPayloadPermissionOptions(event.payload) as PermissionOption[]
        };
        const currentQueue = permissionBySession.current[event.sessionId] ?? [];
        const nextQueue = currentQueue.some((item) => item.requestId === req.requestId)
          ? currentQueue
          : [...currentQueue, req];
        permissionBySession.current[event.sessionId] = nextQueue;
        if (selectedSessionRef.current?.id === event.sessionId) {
          // 当前弹窗尚未响应时保持队首不变；响应后由 handlePermission 自动展示下一项。
          setPermissionRequest((current) => current ?? nextQueue[0] ?? null);
          const visibleRequest = nextQueue[0] ?? req;
          const isPermissionRequest = visibleRequest.options.some(
            (option) => option.kind.startsWith('allow') || option.kind.startsWith('reject')
          );
          setAgentStatus(isPermissionRequest ? '等待审批' : '等待选择');
        }
        return;
      }

      // 主进程仅在严格匹配的静态 Python 问卷上发送该事件；普通工具审批仍走 elicitation_request。
      if (event.type === 'questionnaire_request') {
        const req: QuestionnaireRequest = {
          requestId: getPayloadRequestId(event.payload),
          questions: getPayloadQuestionnaire(event.payload)
        };
        if (!req.requestId || req.questions.length === 0) {
          return;
        }
        const currentQueue = questionnaireBySession.current[event.sessionId] ?? [];
        const nextQueue = currentQueue.some((item) => item.requestId === req.requestId)
          ? currentQueue
          : [...currentQueue, req];
        questionnaireBySession.current[event.sessionId] = nextQueue;
        if (selectedSessionRef.current?.id === event.sessionId) {
          setQuestionnaireRequest((current) => current ?? nextQueue[0] ?? null);
          setAgentStatus('等待选择');
        }
        const recordText = req.questions.map((question, index) => [
          `${index + 1}. ${question.header ? `[${question.header}] ` : ''}${question.question}`,
          ...question.options.map((option) => `   - ${option.label}${option.description ? `：${option.description}` : ''}`)
        ].join('\n')).join('\n');
        const appendRecord = (current: ChatMessage[]) => current.some(
          (message) => message.elicitationRequestId === req.requestId
        ) ? current : [
          ...current,
          {
            id: `questionnaire-${req.requestId}`,
            role: 'elicitation' as const,
            text: recordText,
            elicitationRequestId: req.requestId,
            elicitationKind: 'questionnaire' as const,
            elicitationStatus: 'pending' as const,
            createdAt: new Date().toISOString()
          }
        ];
        if (selectedSessionRef.current?.id === event.sessionId) {
          setMessages((current) => {
            const next = appendRecord(current);
            messageCache.current[event.sessionId] = next;
            return next;
          });
        } else {
          messageCache.current[event.sessionId] = appendRecord(messageCache.current[event.sessionId] ?? []);
        }
        return;
      }

      // ACP elicitation/create（工具/计划审批与 AskTool 原生提问）：按 sessionId 分桶排队。
      if (event.type === 'elicitation_request') {
        const elicitationPlan = splitElicitationPlan(event.message);
        const fullPlan = getPayloadFullPlan(event.payload);
        // fullPlan 为空但 elicitationPlan.plan 非空时，只能展示 message 片段，标记降级。
        const planContent = fullPlan || elicitationPlan.plan;
        const planDegraded = !fullPlan && !!elicitationPlan.plan;
        const req: ElicitationRequest = {
          requestId: getPayloadRequestId(event.payload),
          message: event.message,
          field: getPayloadElicitationField(event.payload),
          kind: getElicitationKind(event.message),
          // 消息流已有对应的方案预览卡时，弹窗只显示简短提示。
          hasPlanPreview: !!planContent
        };
        const currentQueue = elicitationBySession.current[event.sessionId] ?? [];
        const nextQueue = currentQueue.some((item) => item.requestId === req.requestId)
          ? currentQueue
          : [...currentQueue, req];
        elicitationBySession.current[event.sessionId] = nextQueue;
        if (selectedSessionRef.current?.id === event.sessionId) {
          setElicitationRequest((current) => current ?? nextQueue[0] ?? null);
          setAgentStatus(req.kind === 'question' ? '等待选择' : '等待确认');
        }
        // 弹窗负责即时交互，消息流同步保留一条可回溯记录；按 requestId 去重。
        const appendRecord = (current: ChatMessage[]) => {
          if (current.some((message) => message.elicitationRequestId === req.requestId)) {
            return current;
          }
          // 新的实时 plan 审批会替代 `_meta` 恢复卡；后续交互只关联这次有效 requestId。
          const baseMessages = planContent ? current.filter((message) => !message.planActive) : current;
          let next = baseMessages;
          const pendingIndex = baseMessages.findIndex((message) => message.role === 'plan' && message.planPending);
          if (planContent) {
            const preview: ChatMessage = {
              id: pendingIndex >= 0 ? baseMessages[pendingIndex].id : `plan-preview-${req.requestId}`,
              role: 'plan',
              text: planContent,
              planContentType: 'markdown',
              planPreview: true,
              planPreviewRequestId: req.requestId,
              planPreviewDegraded: planDegraded || undefined
            };
            next = pendingIndex >= 0
              ? baseMessages.map((message, index) => index === pendingIndex ? preview : message)
              : [...baseMessages, preview];
          } else if (pendingIndex >= 0) {
            next = baseMessages.map((message, index) =>
              index === pendingIndex ? { ...message, planPreviewRequestId: req.requestId } : message
            );
          }
          return [
            ...next,
            {
              id: `elicitation-${req.requestId}`,
              role: 'elicitation' as const,
              text: elicitationPlan.question || event.message,
              elicitationRequestId: req.requestId,
              elicitationKind: req.kind === 'question' ? 'question' as const : undefined,
              elicitationStatus: 'pending' as const,
              createdAt: new Date().toISOString()
            }
          ];
        };
        if (selectedSessionRef.current?.id === event.sessionId) {
          setMessages((current) => {
            const next = appendRecord(current);
            messageCache.current[event.sessionId] = next;
            return next;
          });
        } else {
          messageCache.current[event.sessionId] = appendRecord(messageCache.current[event.sessionId] ?? []);
        }
        return;
      }

      // 完整方案从磁盘异步读取后单独补发，只更新对应预览，不重复创建审批记录。
      if (event.type === 'elicitation_plan_preview') {
        const requestId = getPayloadRequestId(event.payload);
        const fullPlan = getPayloadFullPlan(event.payload);
        if (!requestId || !fullPlan) {
          return;
        }
        const updatePreview = (current: ChatMessage[]) => {
          const previewIndex = current.findIndex(
            (message) => message.role === 'plan' && message.planPreviewRequestId === requestId
          );
          const preview: ChatMessage = {
            id: previewIndex >= 0 ? current[previewIndex].id : `plan-preview-${requestId}`,
            role: 'plan',
            text: fullPlan,
            planContentType: 'markdown',
            planPreview: true,
            planPreviewRequestId: requestId
          };
          return previewIndex >= 0
            ? current.map((message, index) => index === previewIndex ? preview : message)
            : [...current, preview];
        };
        if (selectedSessionRef.current?.id === event.sessionId) {
          setMessages((current) => {
            const next = updatePreview(current);
            messageCache.current[event.sessionId] = next;
            return next;
          });
        } else {
          messageCache.current[event.sessionId] = updatePreview(messageCache.current[event.sessionId] ?? []);
        }
        return;
      }

      // usage_update（v16.1.13）：每轮结束时 agent 下发上下文用量与费用，不进消息流，
      // 只更新右栏 Agent 状态区的用量展示。按 sessionId 分桶，切会话时还原。
      if (event.type === 'usage_update') {
        usageBySession.current[event.sessionId] = event.message;
        if (selectedSessionRef.current?.id === event.sessionId) {
          setUsageText(event.message);
        }
        return;
      }

      // commands_update：通知该 session 可用 slash 命令列表，同时按项目缓存（新 session 复用）。
      if (event.type === 'commands_update') {
        const commands = getPayloadAvailableCommands(event.payload);
        if (commands.length > 0) {
          setDesktopState((current) => {
            const eventSession = current.recentSessions.find((session) => session.id === event.sessionId);
            const projectPath = eventSession?.projectPath ?? selectedProjectRef.current?.path;
            if (!projectPath) {
              return current;
            }
            const existing = current.configCacheByProjectPath[projectPath];
            return {
              ...current,
              configCacheByProjectPath: {
                ...current.configCacheByProjectPath,
                [projectPath]: {
                  configOptions: existing?.configOptions ?? [],
                  availableCommands: commands,
                  updatedAt: new Date().toISOString()
                }
              }
            };
          });
        }
        if (selectedSessionRef.current?.id === event.sessionId) {
          setAvailableCommands(commands);
        }
        return;
      }

      // config_update：刷新当前 session 的 configOptions；mode/model/thinking 切换都会触发。
      if (event.type === 'config_update') {
        const configOptions = getPayloadConfigOptions(event.payload) as AcpConfigOption[];
        // 同步当前 session 的模型快照到 ref，供 tool_call 实时事件取用。
        const modelOpt = configOptions.find((o) => o.id === 'model');
        if (modelOpt && typeof modelOpt.currentValue === 'string') {
          const id = modelOpt.currentValue;
          const name = modelOpt.options?.find((o) => o.value === id)?.name ?? id;
          modelBySessionRef.current[event.sessionId] = { id, name };
        }
        if (configOptions.length > 0) {
          setDesktopState((current) => {
            const eventSession = current.recentSessions.find((session) => session.id === event.sessionId);
            const projectPath = eventSession?.projectPath ?? selectedProjectRef.current?.path;
            if (!projectPath) {
              return current;
            }
            return {
              ...current,
              configCacheByProjectPath: {
                ...current.configCacheByProjectPath,
                [projectPath]: {
                  configOptions,
                  availableCommands: current.configCacheByProjectPath[projectPath]?.availableCommands ?? [],
                  updatedAt: new Date().toISOString()
                }
              }
            };
          });
        }
        if (selectedSessionRef.current?.id === event.sessionId) {
          setAcpConfigOptions(configOptions);
        }
        return;
      }

      // session_update：主进程已把 ACP 的 session_info_update 写入本地状态，
      // 这里同步刷新左栏标题与当前会话标题，不把它当作聊天消息展示。
      if (event.type === 'session_update') {
        const payload = event.payload as { session?: StoredSession } | undefined;
        const session = payload?.session;
        if (!session) {
          return;
        }
        setDesktopState((current) => {
          const exists = current.recentSessions.some((item) => item.id === session.id);
          return {
            ...current,
            // 已存在则原位更新（仅刷新标题/字段，不置顶）；仅全新会话才插到顶部。
            // 只有用户发消息时才应置顶——那条路径由主进程 upsertSession 默认行为处理。
            recentSessions: exists
              ? current.recentSessions.map((item) => (item.id === session.id ? session : item))
              : [session, ...current.recentSessions]
          };
        });
        updateSelectedSession((current) => (current?.id === session.id ? session : current));
        return;
      }

      if (event.type === 'history_loaded') {
        const historyEvents = getHistoryLoadedEvents(event.payload);
        const historyMessages = historyEvents.reduce(
          (current, historyEvent) => mergeAgentEventIntoMessages(current, historyEvent),
          [] as ChatMessage[]
        );
        const nextMessages = insertHistoricalPlans(historyMessages, getHistoryLoadedPlans(event.payload));
        messageCache.current[event.sessionId] = nextMessages;
        collapseAllToolGroupsForSession(event.sessionId, nextMessages);
        setLoadingHistorySessionId((current) => (current === event.sessionId ? null : current));
        if (selectedSessionRef.current?.id === event.sessionId) {
          setMessages(nextMessages);
          setAgentStatus('历史加载完成');
          setIsAgentBusy(false);
          setHistoryScrollResetToken((value) => value + 1);
        }
        return;
      }

      // 以下事件会构造 ChatMessage，仅影响目标 session 的消息缓存。
      const cacheMessages = (mutator: (list: ChatMessage[]) => ChatMessage[]) => {
        const targetId = event.sessionId;
        if (selectedSessionRef.current?.id === targetId) {
          setMessages((current) => {
            const next = mutator(current);
            messageCache.current[targetId] = next;
            return next;
          });
        } else {
          const previous = messageCache.current[targetId] ?? [];
          messageCache.current[targetId] = mutator(previous);
        }
      };

      if (event.type === 'active_plan_update') {
        const activePlan = getActiveSessionPlan(event.payload);
        if (activePlan) {
          cacheMessages((current) => applyActiveSessionPlan(current, activePlan));
        }
        return;
      }

      const questionnaireRequestId = event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>).questionnaireRequestId
        : undefined;
      if (typeof questionnaireRequestId === 'string' && (event.type === 'status_update' || event.type === 'error')) {
        cacheMessages((current) => current.map((message) =>
          message.elicitationRequestId === questionnaireRequestId
            ? {
                ...message,
                elicitationStatus: event.type === 'error' ? 'failed' : 'accepted',
                elicitationResult: event.type === 'error'
                  ? `问卷答案续发失败：${event.message}`
                  : event.message
              }
            : message
        ));
        if (event.type === 'status_update' && selectedSessionRef.current?.id === event.sessionId) {
          setIsAgentBusy(true);
        }
      }

      if (event.type === 'diff' && selectedSessionRef.current?.id === event.sessionId) {
        setDiffText(event.message);
        setDiffStatus('agent 返回了 diff');
      }

      if (event.type === 'done' && selectedSessionRef.current?.id === event.sessionId) {
        setAgentStatus('完成');
        setIsAgentBusy(false);
        // 自动折叠本轮的工具组：扫描当前 session 消息流，找到本轮最后一条 tool 消息的 id 作为 groupId。
        // 仅在该 groupId 状态为 undefined（用户从未操作）时设为 true；用户主动展开的保持展开。
        const list = messageCache.current[event.sessionId];
        const groupId = list ? findLatestToolGroupId(list) : undefined;
        if (groupId) {
          const bucket = collapsedToolGroupsBySession.current[event.sessionId];
          if (!bucket || bucket[groupId] === undefined) {
            collapsedToolGroupsBySession.current[event.sessionId] = {
              ...(bucket ?? {}),
              [groupId]: true
            };
            bumpCollapsedToolGroups();
          }
        }
        // agent 可能刚写完文件或创建/切换了分支；回合结束时同步 Git 状态，让审查面板保持最新。
        void refreshGitBranches(selectedProjectRef.current);
        void refreshDiff(reviewSourceRef.current, selectedProjectRef.current);
      } else if (event.type === 'error' && selectedSessionRef.current?.id === event.sessionId) {
        setAgentStatus('错误');
        setIsAgentBusy(false);
      } else if (event.type === 'tool_call' && selectedSessionRef.current?.id === event.sessionId) {
        setAgentStatus('调用工具');
      } else if (event.type === 'plan' && selectedSessionRef.current?.id === event.sessionId) {
        setAgentStatus('生成计划');
      } else if (event.type === 'status_update' && selectedSessionRef.current?.id === event.sessionId) {
        setAgentStatus(event.message);
      } else if (selectedSessionRef.current?.id === event.sessionId) {
        setAgentStatus('运行中');
      }

      // omp 真正开始回包：收到 output / tool_call / plan / done / error 任一事件就清掉 pending 卡片，
      // 让位给真正的回复流。即便 omp 直接 done/error 没输出 chunk，pending 也会一并清理，不会卡死。
      if (
        event.type === 'output' ||
        event.type === 'tool_call' ||
        event.type === 'plan' ||
        event.type === 'done' ||
        event.type === 'error'
      ) {
        if (pendingSlashCommandBySession.current[event.sessionId]) {
          pendingSlashCommandBySession.current[event.sessionId] = null;
          bumpPendingSlashCommand();
        }
      }
      cacheMessages((current) =>
        mergeAgentEventIntoMessages(current, event, modelBySessionRef.current[event.sessionId])
      );
    });
  }, [refreshDiff, refreshGitBranches]);

  useEffect(() => {
    let active = true;
    if (!selectedProject || !selectedSession) {
      setAcpConfigOptions([]);
      return () => {
        active = false;
      };
    }

    const loadAgentConfig = async () => {
      const result = await window.ohMyPiDesktop.getAgentConfig(selectedSession.id, selectedProject.path);
      if (active && result.ok) {
        setAcpConfigOptions(result.configOptions ?? []);
      }
    };

    void loadAgentConfig();
    return () => {
      active = false;
    };
  }, [selectedProject, selectedSession]);

  // 打开项目时自动以 omp 的 session/list 为准重建左栏会话列表（去重 + 清理幽灵），与 /resume 对齐。
  useEffect(() => {
    if (!selectedProject) {
      return;
    }
    let active = true;
    void (async () => {
      const result = await window.ohMyPiDesktop.syncSessions(
        selectedProject.path,
        selectedSessionRef.current?.id
      );
      if (active && result.ok && result.state) {
        setDesktopState(result.state);
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedProject?.path]);

  useEffect(() => {
    if (!selectedProject || selectedSession) {
      return;
    }
    const latestSession = desktopState.recentSessions.find(
      (session) => session.projectPath === selectedProject.path && session.acpSessionId
    );
    if (!latestSession?.acpSessionId) {
      return;
    }
    const refreshKey = `${latestSession.id}:${latestSession.acpSessionId}:${latestSession.updatedAt}`;
    if (configRefreshByProject.current[selectedProject.path] === refreshKey) {
      return;
    }
    configRefreshByProject.current[selectedProject.path] = refreshKey;
    void refreshProjectConfigFromSession(latestSession);
  }, [desktopState.recentSessions, selectedProject, selectedSession]);

  const handleSelectWorkspace = async () => {
    const project = await window.ohMyPiDesktop.selectWorkspace();
    if (!project) {
      return;
    }

    // 与 handleUseProject 一致：切项目前先停掉旧 session 的子进程，防止 cwd 残留。
    const previousSessionId = selectedSessionRef.current?.id;
    if (previousSessionId) {
      await window.ohMyPiDesktop.stopSessionProcess(previousSessionId);
      clearApprovalStateForSession(previousSessionId, { alsoClearActive: true });
    }
    selectProject(project);
    // 切项目：清理旧 session 的折叠桶，切回时按需重建。
    resetCollapsedToolGroupsForSession(previousSessionId);
    selectSession(null);
    setMessages([]);
    setLoadingHistorySessionId(null);
    setIsAgentBusy(false);
    setAcpConfigOptions([]);
    setDraftConfigValues({});
    setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
    setApprovalProfileNotice('');
    setApprovalRestoreFailed(false);
    setAvailableCommands([]);
    setDiffText('');
    setDiffStatus('尚未读取 diff');
    setUsageText('');
    setExpandedProjectPaths((current) =>
      current.includes(project.path) ? current : [...current, project.path]
    );
    const status = await window.ohMyPiDesktop.checkOmp(project.path);
    setOmpStatus(status.installed ? status.message : '未安装 omp');
    await reloadState(project.path);
  };

  // 点击会话即打开：恢复消息缓存、权限弹窗与该 session 专属 config（多 session 隔离的还原点）。
  // 若是带 acpSessionId 的历史会话且本地还没有缓存消息，则自动重放历史内容到中间对话区，
  // 替代原先独立的「重放历史」按钮。
  const handleSelectSession = (session: StoredSession) => {
    selectSession(session);
    const cached = messageCache.current[session.id] ?? [];
    setMessages(cached);
    setIsAgentBusy(false);
    setAcpConfigOptions([]);
    setDraftConfigValues({});
    setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
    setApprovalProfileNotice('');
    setApprovalRestoreFailed(false);
    setAvailableCommands([]);
    setDiffText('');
    setDiffStatus('尚未读取 diff');
    setUsageText(usageBySession.current[session.id] ?? '');
    setPermissionRequest(permissionBySession.current[session.id]?.[0] ?? null);
    setElicitationRequest(elicitationBySession.current[session.id]?.[0] ?? null);
    setQuestionnaireRequest(questionnaireBySession.current[session.id]?.[0] ?? null);
    if (session.acpSessionId && cached.length === 0) {
      setLoadingHistorySessionId(session.id);
      void replayHistory(session);
    } else if (session.acpSessionId) {
      setLoadingHistorySessionId(null);
      setHistoryScrollResetToken((value) => value + 1);
      void resumeSessionForConfig(session);
    } else {
      setLoadingHistorySessionId(null);
    }
  };

  // 切换已有项目目录：必须把旧 session 的子进程停掉，并把 selectedSession 重置为 null。
  // 否则 sendContent 可能复用旧 session id，命中 agentProcesses 里 cwd 仍是旧项目的子进程，
  // 导致「切了项目但指令仍跑在旧目录」——见 sendAgentMessage 的主进程防御与这里的根因修复。
  // 注意：这里不调用 useWorkspace，避免普通点击项目时把该项目移动到最近项目列表顶部。
  const handleUseProject = async (project: StoredProject) => {
    // 先停掉旧 session 残留的子进程，避免它继续占用 cwd 或被后续 sendAgentMessage 复用。
    const previousSessionId = selectedSessionRef.current?.id;
    if (previousSessionId) {
      await window.ohMyPiDesktop.stopSessionProcess(previousSessionId);
      clearApprovalStateForSession(previousSessionId, { alsoClearActive: true });
    }
    selectProject(project);
    // 切项目：清理旧 session 的折叠桶。
    resetCollapsedToolGroupsForSession(previousSessionId);
    // 不再用闭包里的 desktopState 选旧 session：那份数据在 reloadState/syncSessions 完成前是陈旧的，
    // 可能选到不属于本项目的 session。统一置 null，由用户在左栏手动点开，或发消息时新建。
    selectSession(null);
    setMessages([]);
    setLoadingHistorySessionId(null);
    setIsAgentBusy(false);
    setAcpConfigOptions([]);
    setDraftConfigValues({});
    setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
    setApprovalProfileNotice('');
    setApprovalRestoreFailed(false);
    setAvailableCommands([]);
    setDiffText('');
    setDiffStatus('尚未读取 diff');
    setUsageText('');
    const status = await window.ohMyPiDesktop.checkOmp(project.path);
    setOmpStatus(status.installed ? status.message : '未安装 omp');
    await reloadState(project.path);
  };
  // 选择 omp 可执行文件：打开文件对话框、保存设置、验证并刷新状态 pill。
  // 若当前有对话在运行，先提示用户确认，避免意外中断。
  const handleSelectOmpPath = async () => {
    if (isAgentBusy) {
      const confirmed = window.confirm('当前有正在运行的对话，切换 omp 会中断该对话，是否继续？');
      if (!confirmed) {
        return;
      }
    }
    const result = await window.ohMyPiDesktop.selectOmpPath();
    if (result.path !== undefined) {
      setOmpPath(result.path);
    }
    // 路径切换成功后，若当前有选中的 session，立即用新 omp 重启它。
    if (result.ok && selectedSession && selectedProject) {
      await window.ohMyPiDesktop.startAgent(selectedSession.id, selectedProject.path);
    }
    if (selectedProject) {
      const status = await window.ohMyPiDesktop.checkOmp(selectedProject.path);
      setOmpStatus(status.installed ? status.message : '未安装 omp');
    } else {
      setOmpStatus(result.ok ? (result.message || 'omp 已设置') : (result.message || 'omp 设置失败'));
    }
  };


  const toggleProjectExpanded = (projectPath: string) => {
    setExpandedProjectPaths((current) =>
      current.includes(projectPath)
        ? current.filter((path) => path !== projectPath)
        : [...current, projectPath]
    );
  };

  // 点击 session 即进入执行目录：切换 selectedProject（若不同）+ 选中该 session。
  // 这是唯一会切换执行目录的入口，故在此通过 useWorkspace 更新 lastOpenedAt，
  // 使「上次执行目录」= 用户最后操作的目录（而非最后浏览的目录）。
  const handleSelectProjectSession = async (project: StoredProject, session: StoredSession) => {
    setExpandedProjectPaths((current) =>
      current.includes(project.path) ? current : [...current, project.path]
    );
    if (selectedProject?.path !== project.path) {
      // 切换执行目录前先停掉旧 session 子进程，并刷新 lastOpenedAt（不重排项目顺序）。
      await handleUseProject(project);
      await window.ohMyPiDesktop.touchProjectLastOpened(project.path);
    }
    handleSelectSession(session);
  };

  // 手动同步（↻ 按钮）：与打开项目时的自动同步同一路径——
  // 以 omp 的 session/list 为准重建当前项目会话列表（按 acpSessionId 去重 + 清理 omp 已无的幽灵行）。
  const syncProjectSessions = async (workspacePath: string) => {
    setAgentStatus('同步历史会话中');
    const result = await window.ohMyPiDesktop.syncSessions(workspacePath, selectedSessionRef.current?.id);
    if (!result.ok) {
      setAgentStatus(result.message ?? '同步失败');
      return;
    }
    if (result.state) {
      setDesktopState(result.state);
    }
    const count = result.state?.recentSessions.filter((session) => session.projectPath === workspacePath).length ?? 0;
    setAgentStatus(`已同步 ${count} 个会话`);
  };
  // 切换项目置顶：调用主进程写盘并把最新 state 回填，displayedProjects memo 自动重排。
  const handleToggleProjectPinned = async (project: StoredProject) => {
    const next = !project.pinned;
    const updated = await window.ohMyPiDesktop.setProjectPinned(project.path, next);
    if (!updated) {
      setAgentStatus('置顶失败：项目不存在');
      return;
    }
    setDesktopState((current) => ({
      ...current,
      recentProjects: current.recentProjects.map((item) => (item.path === updated.path ? updated : item))
    }));
    setAgentStatus(next ? `已置顶 ${updated.name}` : `已取消置顶 ${updated.name}`);
  };

  // 在系统资源管理器中打开项目目录：走主进程 shell.openPath 跨平台语义一致。
  const handleRevealProject = async (project: StoredProject) => {
    const result = await window.ohMyPiDesktop.revealInExplorer(project.path);
    if (!result.ok) {
      setAgentStatus(result.message ? `打开目录失败：${result.message}` : '打开目录失败');
    }
  };

  // 重命名项目：只改 displayName（不影响磁盘目录、path、session）。
  const handleRenameProject = async (project: StoredProject, displayName: string) => {
    const updated = await window.ohMyPiDesktop.setProjectDisplayName(project.path, displayName);
    if (!updated) {
      setAgentStatus('重命名失败：项目不存在');
      return;
    }
    setDesktopState((current) => ({
      ...current,
      recentProjects: current.recentProjects.map((item) => (item.path === updated.path ? updated : item))
    }));
    setAgentStatus(`已重命名为 ${updated.displayName ?? updated.name}`);
  };

  // 移除项目：从左栏删掉，会话行保留。若该项目的 agent 子进程在跑需先杀掉，
  // 否则进程会变孤儿但仍在后台占用资源。
  const handleRemoveProject = async (project: StoredProject) => {
    // 移除前若该项目正在被作为执行目录使用，先停掉其下任意仍在跑的会话进程。
    // recentSessions 里属该 projectPath 的会话逐一 stopSessionProcess 兜底。
    const sessionsToRemove = desktopState.recentSessions.filter(
      (session) => session.projectPath === project.path
    );
    for (const session of sessionsToRemove) {
      await window.ohMyPiDesktop.stopSessionProcess(session.id);
    }
    const removed = await window.ohMyPiDesktop.removeProject(project.path);
    if (!removed) {
      setAgentStatus('移除失败：项目不存在');
      return;
    }
    for (const session of sessionsToRemove) {
      clearApprovalStateForSession(session.id, { alsoClearActive: true });
    }
    setDesktopState((current) => ({
      ...current,
      recentProjects: current.recentProjects.filter((item) => item.path !== project.path)
    }));
    // 若移除的是当前执行目录，清空选中态，并把当前会话相关的运行时缓存一并清空，
    // 让中间/右栏落到干净的空白态，避免「无目录 + 旧消息/用量/diff 残留」。
    if (selectedProjectRef.current?.path === project.path) {
      selectProject(null);
      // 清空当前展示的消息流及其按 sessionId 的缓存（你已确认清掉）。
      setMessages([]);
      for (const session of sessionsToRemove) {
        delete messageCache.current[session.id];
        delete usageBySession.current[session.id];
        delete collapsedToolGroupsBySession.current[session.id];
        delete pendingSlashCommandBySession.current[session.id];
      }
      // 清掉当前展示的右栏运行时状态。
      setAgentStatus('');
      setUsageText('');
      setDiffText('');
      setDiffStatus('尚未读取 diff');
      setLoadingHistorySessionId(null);
      // 草稿配置按 sessionId 维护；清掉对应条目，避免下次同 id 会话复用残留草稿。
      setDraftConfigValues({});
      setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
      setApprovalProfileNotice('');
      setApprovalRestoreFailed(false);
      // 权限弹窗 / pending slash / 输入草稿：当前会话已不存在，全部置空。
      pendingSlashCommandBySession.current = {};
      setPendingSlashCommandVersion((v) => v + 1);
      setPrompt('');
      setPendingAttachments([]);
      setSelectedSession(null);
      selectedSessionRef.current = null;
    }
    setAgentStatus(`已移除 ${removed.name}`);
  };

  // 重放历史：对带 acpSessionId 的历史会话走 session/load。
  // 主进程会把 replay 期间的聊天事件缓存起来，完成后一次性推送 history_loaded。
  const replayHistory = async (session: StoredSession) => {
    if (!session.acpSessionId) {
      return;
    }
    setAgentStatus('加载历史中');
    const result = await window.ohMyPiDesktop.loadSession(
      session.id,
      session.projectPath,
      session.acpSessionId
    );
    if (!result.ok) {
      setLoadingHistorySessionId((current) => (current === session.id ? null : current));
      if (selectedSessionRef.current?.id === session.id) {
        setAgentStatus(result.message ?? '加载历史失败');
      }
    }
    await reloadState(session.projectPath);
  };

  // 已有消息缓存时不重复重放历史，只恢复 ACP session，让 model/mode/thinking 配置重新推送到输入区。
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
      setAgentStatus(result.message ?? '恢复配置失败');
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
    setDesktopState((current) => ({
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

  // 关闭指定 session（向 agent 发送 session/close + 杀掉子进程）。
  // 作用在被点击的会话上：若是当前选中会话则清空中间栏，否则只清后台桶。
  const handleCloseSession = async (session: StoredSession) => {
    const isCurrent = selectedSessionRef.current?.id === session.id;
    const result = await window.ohMyPiDesktop.closeSession(session.id);
    setAgentStatus(result.ok ? 'session 已关闭' : result.message ?? '关闭失败');
    if (!result.ok) {
      return;
    }
    // 关闭时同步清掉对应 session 的 pending 卡片（即便 omp 不再回 done/error 也不会残留）。
    pendingSlashCommandBySession.current[session.id] = null;
    if (isCurrent) {
      bumpPendingSlashCommand();
    }
    // 关闭会话：清掉折叠桶，避免重新打开该会话看到旧折叠态残留。
    resetCollapsedToolGroupsForSession(session.id);
    clearApprovalStateForSession(session.id, { alsoClearActive: isCurrent });
    if (isCurrent) {
      selectSession(null);
      setMessages([]);
      setLoadingHistorySessionId(null);
      setIsAgentBusy(false);
      setAcpConfigOptions([]);
      setDraftConfigValues({});
      setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
      setApprovalProfileNotice('');
      setApprovalRestoreFailed(false);
      setAvailableCommands([]);
      setDiffText('');
      setDiffStatus('尚未读取 diff');
      setUsageText('');
    }
  };

  // Fork 指定会话：以该会话 acpSessionId 为源整会话复制（ACP unstable_session/fork）。
  // 作用在被点击的会话上：forkSession 用 newLocalId 作进程 key 启动新进程执行 fork，
  // 不依赖源会话是否有运行中的进程——因此无需先「切到源会话」触发它的历史重放，
  // 避免源会话 replay 与 fork replay 并发竞争。
  // 跨项目 fork 时需先把执行目录切到目标项目（停旧进程 + selectProject），再建 fork 占位会话。
  const handleForkSession = async (project: StoredProject, session: StoredSession) => {
    if (!session.acpSessionId) {
      setAgentStatus('该会话尚未关联到远端 acpSessionId，无法 Fork');
      return;
    }
    // 快照操作前的项目与会话：fork 失败时用于回滚到原上下文，避免停留在占位会话上。
    const previousProject = selectedProjectRef.current;
    const previousSession = selectedSessionRef.current;
    // 跨项目 fork：停掉旧 session 子进程（cwd 防御），切到目标项目。
    // 不走 handleUseProject——它会 selectSession(null) 并清空中间栏，而下面要立即 selectSession(forked)。
    if (selectedProjectRef.current?.path !== project.path) {
      const previousSessionId = selectedSessionRef.current?.id;
      if (previousSessionId) {
        await window.ohMyPiDesktop.stopSessionProcess(previousSessionId);
        clearApprovalStateForSession(previousSessionId, { alsoClearActive: true });
      }
      selectProject(project);
      const status = await window.ohMyPiDesktop.checkOmp(project.path);
      setOmpStatus(status.installed ? status.message : '未安装 omp');
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
    messageCache.current[newLocalId] = [];
    permissionBySession.current[newLocalId] = [];
    elicitationBySession.current[newLocalId] = [];
    questionnaireBySession.current[newLocalId] = [];
    usageBySession.current[newLocalId] = '';
    // fork 占位会话折叠桶初始化为空：fork 完成后由 collapseAllToolGroupsForSession 一次性折叠全部工具组。
    collapsedToolGroupsBySession.current[newLocalId] = {};
    bumpCollapsedToolGroups();
    selectSession(forked);
    setMessages([]);
    setLoadingHistorySessionId(newLocalId);
    setAgentStatus('Fork 中，正在加载历史');
    setIsAgentBusy(false);
    setAcpConfigOptions([]);
    setDraftConfigValues({});
    setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
    setApprovalProfileNotice('');
    setApprovalRestoreFailed(false);
    setDiffText('');
    setDiffStatus('尚未读取 diff');
    setUsageText('');
    setPermissionRequest(null);
    setElicitationRequest(null);
    setQuestionnaireRequest(null);
    const result = await window.ohMyPiDesktop.forkSession(newLocalId, project.path, sourceAcpSessionId);
    if (!result.ok) {
      // fork 失败：清理占位会话的四个缓存条目，避免左栏残留幽灵会话与缓存泄漏。
      delete messageCache.current[newLocalId];
      clearApprovalStateForSession(newLocalId, { alsoClearActive: true });
      delete usageBySession.current[newLocalId];
      delete collapsedToolGroupsBySession.current[newLocalId];
      bumpCollapsedToolGroups();
      // 兜底杀掉可能已 spawn 但 ACP 握手/fork 阶段失败的 agent 子进程（不存在则 no-op）。
      window.ohMyPiDesktop.stopSessionProcess(newLocalId);
      setLoadingHistorySessionId((current) => (current === newLocalId ? null : current));
      // 跨项目 fork 失败：回滚到原项目与会话，恢复消息/用量/权限/配置缓存。
      // 同项目 fork 失败：置空选中会话，清空中间栏，左栏不再并入占位行。
      if (previousProject && previousSession && previousProject.path !== project.path) {
        selectProject(previousProject);
        selectSession(previousSession);
        setMessages(messageCache.current[previousSession.id] ?? []);
        setUsageText(usageBySession.current[previousSession.id] ?? '');
        setPermissionRequest(permissionBySession.current[previousSession.id]?.[0] ?? null);
        setElicitationRequest(elicitationBySession.current[previousSession.id]?.[0] ?? null);
        setQuestionnaireRequest(questionnaireBySession.current[previousSession.id]?.[0] ?? null);
        // 还原原项目的 ACP 配置缓存，让顶栏选择器立即显示正确选项。
        setAcpConfigOptions(
          desktopState.configCacheByProjectPath[previousProject.path]?.configOptions ?? []
        );
        setDraftConfigValues({});
        setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
        setApprovalProfileNotice('');
        setApprovalRestoreFailed(false);
        setAvailableCommands([]);
      } else {
        selectSession(null);
        setMessages([]);
      }
      setAgentStatus(result.message ?? 'Fork 失败');
      return;
    }
    // 用 fork 回传的新 acpSessionId 补全占位会话，便于后续读取配置 / 再次 fork。
    const newAcpSessionId = result.sessionId;
    if (newAcpSessionId) {
      updateSelectedSession((current) =>
        current && current.id === newLocalId ? { ...current, acpSessionId: newAcpSessionId } : current
      );
    }
    setAgentStatus('已 Fork');
    await reloadState(project.path);
  };

  const handleNewSession = async (project = selectedProject) => {
    if (!project) {
      return;
    }
    if (selectedProject?.path !== project.path) {
      await handleUseProject(project);
      await window.ohMyPiDesktop.touchProjectLastOpened(project.path);
    }
    setExpandedProjectPaths((current) =>
      current.includes(project.path) ? current : [...current, project.path]
    );
    // 顶部「新建会话」只进入空白会话界面；真正的本地 session 在首次发送消息时延迟创建。
    // 清理上一个 session 的折叠桶，避免重新进入历史 session 时看到旧折叠态残留。
    resetCollapsedToolGroupsForSession(selectedSessionRef.current?.id);
    selectSession(null);
    setMessages([]);
    setLoadingHistorySessionId(null);
    setAgentStatus('空闲');
    setIsAgentBusy(false);
    setAcpConfigOptions([]);
    setDraftConfigValues({});
    setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
    setApprovalProfileNotice('');
    setApprovalRestoreFailed(false);
    setAvailableCommands([]);
    setDiffText('');
    setDiffStatus('尚未读取 diff');
    setUsageText('');
    setPermissionRequest(null);
    setElicitationRequest(null);
    setQuestionnaireRequest(null);
  };

  const hasDraftConfigValues = (values: DraftConfigValues) => {
    return Boolean(values.model || values.mode || values.thinking);
  };

  const applyDraftConfigValues = async (
    session: StoredSession,
    workspacePath: string,
    values: DraftConfigValues
  ) => {
    const entries: Array<['model' | 'mode' | 'thinking', string | undefined]> = [
      ['model', values.model],
      ['mode', values.mode],
      ['thinking', values.thinking]
    ];
    for (const [configId, value] of entries) {
      if (!value) {
        continue;
      }
      const result = await window.ohMyPiDesktop.setAgentConfigOption(
        session.id,
        workspacePath,
        configId,
        value
      );
      if (result.ok) {
        setAcpConfigOptions(result.configOptions ?? []);
      } else {
        setAgentStatus(result.message ?? '草稿配置已变化，跳过该项');
      }
    }
  };

  const isPlanModeSelected = () => {
    const modeValue = typeof modeConfig?.currentValue === 'string' ? modeConfig.currentValue : '';
    const modeName = modeConfig?.options?.find((option) => option.value === modeValue)?.name ?? '';
    const normalized = `${modeValue} ${modeName}`.toLowerCase();
    // 兼容不同 omp 版本的 mode value/name：常见值为 plan，中文环境可能显示“计划”。
    return normalized.includes('plan') || normalized.includes('计划');
  };

  // 通用发送：支持 text + images 列表。
  const sendContent = async (text: string, attachments: PendingAttachment[]) => {
    if (!selectedProject) {
      return;
    }
    let session = selectedSession;
    // 新建 session 时要把输入区当前显示的 ACP 配置（model/mode/thinking）全部应用，
    // 不再只应用用户显式改过的草稿值——否则未改动项会落到 omp 默认配置，
    // 出现"重启后直接发消息用了别的模型/推理强度"的问题。
    // 来源：displayedConfigOptions 已合并缓存配置 + 草稿覆盖，直接取 currentValue。
    let configValuesToApply: DraftConfigValues = {};
    // 防御：若 selectedSession 不属于当前 selectedProject（理论上不应发生，但闭包/快速切换下可能），
    // 视同没有 session，新建一个绑定到当前项目的 session，避免复用旧项目子进程。
    if (!session || session.projectPath !== selectedProject.path) {
      for (const option of displayedConfigOptions) {
        const key = option.id as keyof DraftConfigValues;
        if (key === 'model' || key === 'mode' || key === 'thinking') {
          const value =
            draftConfigValues[key] ??
            (typeof option.currentValue === 'string' ? option.currentValue : undefined);
          if (value) {
            configValuesToApply[key] = value;
          }
        }
      }
      session = await window.ohMyPiDesktop.createSession(
        selectedProject.path,
        text.trim().slice(0, 42) || '新的 agent 会话',
        draftApprovalProfile
      );
      setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
    }
    if (hasDraftConfigValues(configValuesToApply)) {
      setAgentStatus('应用会话配置');
      await applyDraftConfigValues(session, selectedProject.path, configValuesToApply);
      setDraftConfigValues({});
    }
    // 先应用草稿配置再切到真实 session，避免 selectSession 将 displayedConfigOptions
    // 从缓存+草稿覆盖切换到空的 acpConfigOptions，导致顶栏选择器短暂显示"模型未加载"。
    selectSession(session);
    setAgentStatus('运行中');
    setIsAgentBusy(true);
    // 立即在底部插入「正在执行 slash 命令」卡片：仅当用户输入是合法 slash 命令时设置，
    // 由 onAgentEvent 收到首个 output/tool_call/plan/done/error 时清掉。
    const parsed = parseSlashCommand(text);
    const showPlanPending = !parsed && isPlanModeSelected();
    if (parsed) {
      const meta = resolveCommandPendingMeta(parsed.name);
      pendingSlashCommandBySession.current[session.id] = {
        id: `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: parsed.name,
        args: parsed.args,
        sentAt: new Date().toISOString(),
        icon: meta.icon,
        label: meta.label
      };
      bumpPendingSlashCommand();
    }
    setMessages((current) => {
      const userMessage: ChatMessage = {
        id: `${Date.now()}-user`,
        role: 'user',
        text: text.trim()
      };
      if (!showPlanPending) {
        return [...current, userMessage];
      }
      return [
        ...current,
        userMessage,
        {
          id: `plan-pending-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'plan',
          text: '正在整理任务步骤，稍后会替换为正式计划。',
          planPending: true
        }
      ];
    });
    const result = await window.ohMyPiDesktop.sendAgentMessage(session.id, selectedProject.path, {
      text: text.trim(),
      attachments: attachments.map((att) => ({ dataUrl: att.dataUrl, fileName: att.fileName, kind: att.kind }))
    });
    if (!result.ok) {
      setIsAgentBusy(false);
      setAgentStatus(result.message ?? '错误');
    }
    await reloadState();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProject || !prompt.trim()) {
      return;
    }
    const text = prompt.trim();
    const attachments = pendingAttachments;
    setPrompt('');
    setPendingAttachments([]);
    await sendContent(text, attachments);
  };

  // 给会话输入框追加一个附件（File 对象）。粘贴 / 文件选择都走这里。
  // 按 MIME + 扩展名判定 kind，受 8MB 上限保护：超过拒绝，避免一次上传把 IPC 撑爆。
  const handleAttachAttachment = (file: File) => {
    const kind = classifyAttachment(file);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        return;
      }
      const dataUrl = reader.result;
      if (dataUrl.length > (MAX_IMAGE_BYTES * 4) / 3) {
        setAgentStatus('附件超过 8MB，未添加');
        return;
      }
      setPendingAttachments((current) => [
        ...current,
        { dataUrl, fileName: file.name, kind }
      ]);
    };
    reader.readAsDataURL(file);
  };

  // 通过系统文件选择器挑选任意文件：用隐藏的 <input type=file> 触发，
  // 不限制 accept；选中后走 handleAttachAttachment（统一判定 kind 与大小校验）。
  // 每次点击都新建 input，确保同一文件可被重复选中（input.value 清空）。
  const handleSelectFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      handleAttachAttachment(file);
    };
    input.click();
  };

  const handleCancelTurn = async () => {
    if (!selectedSession) {
      return;
    }
    const result = await window.ohMyPiDesktop.cancelAgentTurn(selectedSession.id);
    if (result.ok) {
      clearApprovalStateForSession(selectedSession.id, { alsoClearActive: true });
      setAgentStatus('正在取消');
      setIsAgentBusy(false);
    } else {
      setAgentStatus('取消失败');
    }
  };

  const handleRefreshGitReview = async () => {
    // 用户主动刷新时同时同步分支列表、暂存区和工作区改动。
    await syncGitReview();
  };

  const handleReviewSourceChange = (source: ReviewSource) => {
    reviewSourceRef.current = source;
    setReviewSource(source);
  };

  const handleGitBranchChange = async (branchName: string) => {
    const project = selectedProjectRef.current;
    if (!project || !branchName || branchName === currentGitBranch || switchingGitBranch) {
      return;
    }

    setSwitchingGitBranch(true);
    setGitBranchSwitchError(null);
    setGitBranchNotice(`正在切换到 ${branchName}...`);
    try {
      const result = await window.ohMyPiDesktop.switchGitBranch(project.path, branchName);
      if (selectedProjectRef.current?.path !== project.path) {
        return;
      }
      if (!result.ok) {
        // 分支切换失败属于阻断操作，使用全局弹窗确保右栏折叠时用户仍能看到处理建议。
        const failure = resolveGitBranchSwitchFailure(result.reason, result.message);
        setGitBranchNotice('');
        setGitBranchSwitchError({
          ...failure,
          currentBranch: currentGitBranch,
          targetBranch: branchName
        });
        return;
      }
      setGitBranchNotice(`已切换到 ${branchName}`);
      await refreshGitBranches(project);
      await refreshDiff(reviewSourceRef.current, project);
    } catch (error) {
      // IPC 异常保留给开发者控制台排查，前端只显示不含内部细节的中文提示。
      console.error('切换 Git 分支请求失败', error);
      const failure = resolveGitBranchSwitchFailure('unknown');
      setGitBranchNotice('');
      setGitBranchSwitchError({
        ...failure,
        currentBranch: currentGitBranch,
        targetBranch: branchName
      });
    } finally {
      if (selectedProjectRef.current?.path === project.path) {
        setSwitchingGitBranch(false);
      }
    }
  };

  const closeGitBranchSwitchError = useCallback(() => {
    setGitBranchSwitchError(null);
  }, []);

  const handleModelChange = async (modelId: string) => {
    if (!selectedProject || !modelId) {
      return;
    }
    if (!selectedSession) {
      setDraftConfigValues((current) => ({ ...current, model: modelId }));
      return;
    }
    setAgentStatus('切换模型');
    const result = await window.ohMyPiDesktop.setAgentConfigOption(
      selectedSession.id,
      selectedProject.path,
      'model',
      modelId
    );
    if (result.ok) {
      setAcpConfigOptions(result.configOptions ?? []);
      setAgentStatus('空闲');
    } else {
      setAgentStatus('错误');
    }
  };

  const handleModeChange = async (modeId: string) => {
    if (!selectedProject || !modeId) {
      return;
    }
    if (!selectedSession) {
      setDraftConfigValues((current) => ({ ...current, mode: modeId }));
      return;
    }
    setAgentStatus('切换模式');
    const result = await window.ohMyPiDesktop.setAgentConfigOption(
      selectedSession.id,
      selectedProject.path,
      'mode',
      modeId
    );
    if (result.ok) {
      setAcpConfigOptions(result.configOptions ?? []);
      setAgentStatus('空闲');
    } else {
      setAgentStatus('错误');
    }
  };

  const handleThinkingChange = async (thinkingId: string) => {
    if (!selectedProject || !thinkingId) {
      return;
    }
    if (!selectedSession) {
      setDraftConfigValues((current) => ({ ...current, thinking: thinkingId }));
      return;
    }
    setAgentStatus('切换推理强度');
    const result = await window.ohMyPiDesktop.setAgentConfigOption(
      selectedSession.id,
      selectedProject.path,
      'thinking',
      thinkingId
    );
    if (result.ok) {
      setAcpConfigOptions(result.configOptions ?? []);
      setAgentStatus('空闲');
    } else {
      setAgentStatus('错误');
    }
  };

  const handleApprovalProfileChange = async (approvalProfile: ApprovalProfile) => {
    if (!selectedProject) {
      return;
    }
    if (!selectedSession) {
      setDraftApprovalProfile(approvalProfile);
      setApprovalProfileNotice('');
      setApprovalRestoreFailed(false);
      return;
    }

    const existingProfile = selectedSession.approvalProfile ?? DEFAULT_APPROVAL_PROFILE;
    if (existingProfile === approvalProfile && !approvalRestoreFailed) {
      return;
    }
    const willInterrupt = isAgentBusy || Boolean(permissionRequest) || Boolean(elicitationRequest) || Boolean(questionnaireRequest);
    const confirmed = window.confirm(
      willInterrupt
        ? '切换审批档位会取消当前回合，未完成的操作可能中断，并重启当前会话的 agent 运行环境。是否继续？'
        : '切换审批档位会重启当前会话的 agent 运行环境。是否继续？'
    );
    if (!confirmed) {
      return;
    }

    // 旧进程的审批请求即将失效，先清理当前会话的渲染缓存，避免留下可操作弹窗。
    clearApprovalStateForSession(selectedSession.id, { alsoClearActive: true });
    setIsAgentBusy(false);
    setAgentStatus('正在切换审批档位');
    setApprovalProfileNotice('');
    const result = await window.ohMyPiDesktop.updateSessionApprovalProfile(
      selectedSession.id,
      selectedProject.path,
      approvalProfile
    ).catch((error: unknown) => {
      console.error('updateSessionApprovalProfile failed:', error);
      return { ok: false, session: undefined, message: '审批档位切换失败，请重试' };
    });
    // IPC 完成后再清一次，覆盖取消与终止窗口内可能刚到达的旧 permission 事件。
    clearApprovalStateForSession(selectedSession.id, { alsoClearActive: true });

    const updatedSession = result.session;
    if (updatedSession) {
      setDesktopState((current) => ({
        ...current,
        recentSessions: current.recentSessions.map((session) =>
          session.id === updatedSession.id ? updatedSession : session
        )
      }));
      updateSelectedSession((current) =>
        current?.id === updatedSession.id ? updatedSession : current
      );
    }
    if (result.ok) {
      setApprovalRestoreFailed(false);
      setApprovalProfileNotice(result.message ?? '');
      setAgentStatus('审批档位已切换');
      return;
    }
    setApprovalRestoreFailed(Boolean(result.session));
    setApprovalProfileNotice(result.message ?? '审批档位切换失败，请重试');
    setAgentStatus('审批档位切换失败');
  };

  // 权限审批：调用 IPC 后清理当前 session 的弹窗缓存（其它 session 的不受影响）。
  const handlePermission = async (optionId: string) => {
    if (!permissionRequest || !selectedSession) {
      return;
    }
    const sessionId = selectedSession.id;
    const requestId = permissionRequest.requestId;
    const result = await window.ohMyPiDesktop.permissionOptionResponse(requestId, optionId);
    if (!result.ok) {
      setAgentStatus('审批失败');
      return;
    }
    const remaining = (permissionBySession.current[sessionId] ?? []).filter(
      (request) => request.requestId !== requestId
    );
    permissionBySession.current[sessionId] = remaining;
    if (selectedSessionRef.current?.id === sessionId) {
      const nextRequest = remaining[0] ?? null;
      setPermissionRequest(nextRequest);
      const nextIsPermission = nextRequest?.options.some(
        (option) => option.kind.startsWith('allow') || option.kind.startsWith('reject')
      );
      setAgentStatus(nextRequest ? (nextIsPermission ? '等待审批' : '等待选择') : '继续运行');
    }
  };

  // elicitation 响应：工具审批与 AskTool 共用，action 为 accept（携带 content）/ decline / cancel。
  // 按 requestId 从当前会话队列查原始请求（用于 kind 和结果文本），每个 pending 请求可独立响应，
  // 不再依赖队首 state——近同时提交两个不同 requestId 的 IPC 互不阻塞。
  const handleElicitation = async (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ) => {
    if (!selectedSession) {
      return;
    }
    const sessionId = selectedSession.id;
    const matched = (elicitationBySession.current[sessionId] ?? []).find(
      (item) => item.requestId === requestId
    );
    if (!matched) {
      // 请求已失效或属于其他会话。
      return;
    }
    const requestKind = matched.kind;
    // IPC 往返前先给出反馈并隐藏操作控件，避免用户重复提交同一 AskTool 回答。
    const submittingText = requestKind === 'question' ? '正在提交选择…' : '正在提交确认…';
    const markSubmitting = (current: ChatMessage[]) => current.map((message) =>
      message.elicitationRequestId === requestId
        ? { ...message, elicitationStatus: 'submitting' as const, elicitationResult: submittingText }
        : message
    );
    setAgentStatus(requestKind === 'question' ? '正在提交选择' : '正在提交确认');
    setMessages((current) => {
      const next = markSubmitting(current);
      messageCache.current[sessionId] = next;
      return next;
    });
    const result = await window.ohMyPiDesktop.elicitationResponse(requestId, action, content);
    // IPC 等待期间用户可能切换会话：只更新请求所属会话，避免把结果写进新会话消息流。
    const updateElicitationRecord = (
      status: NonNullable<ChatMessage['elicitationStatus']>,
      resultText: string
    ) => {
      const updateMessages = (current: ChatMessage[]) => current.map((message) => {
        if (message.elicitationRequestId === requestId) {
          return { ...message, elicitationStatus: status, elicitationResult: resultText };
        }
        if (message.planPreviewRequestId === requestId && status !== 'failed') {
          // 请求完成后方案仍作为文档保留，但不再标记为“待确认”。
          return { ...message, planPreview: false, planPreviewRequestId: undefined };
        }
        return message;
      });
      if (selectedSessionRef.current?.id === sessionId) {
        setMessages((current) => {
          const next = updateMessages(current);
          messageCache.current[sessionId] = next;
          return next;
        });
      } else {
        messageCache.current[sessionId] = updateMessages(messageCache.current[sessionId] ?? []);
      }
    };
    const remaining = (elicitationBySession.current[sessionId] ?? []).filter(
      (request) => request.requestId !== requestId
    );
    elicitationBySession.current[sessionId] = remaining;
    if (!result.ok) {
      // 主进程返回失败表示请求已不存在，关闭失效弹窗，避免用户重复提交进入死循环。
      updateElicitationRecord('failed', '确认失败：请求已失效');
      if (selectedSessionRef.current?.id === sessionId) {
        setElicitationRequest(remaining[0] ?? null);
        setAgentStatus(remaining[0]
          ? (remaining[0].kind === 'question' ? '等待选择' : '等待确认')
          : (requestKind === 'question' ? '提交失败' : '确认失败'));
      }
      return;
    }
    const elicitationResult = getElicitationResultText(matched, action, content);
    updateElicitationRecord(
      action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled',
      elicitationResult
    );
    if (selectedSessionRef.current?.id === sessionId) {
      setElicitationRequest(remaining[0] ?? null);
      setAgentStatus(remaining[0]
        ? (remaining[0].kind === 'question' ? '等待选择' : '等待确认')
        : '继续运行');
    }
  };

  // 把指定 requestId 的问卷从队列移除，并推进当前弹窗到下一项或置空。
  // 成功分支与 stale 失败分支共用，避免重复实现清理 + 推进逻辑；agentStatus 由调用方按各自语义设置。
  const advanceToNextQuestionnaire = (requestId: string, sessionId: string) => {
    const remaining = (questionnaireBySession.current[sessionId] ?? []).filter(
      (request) => request.requestId !== requestId
    );
    questionnaireBySession.current[sessionId] = remaining;
    if (selectedSessionRef.current?.id === sessionId) {
      setQuestionnaireRequest(remaining[0] ?? null);
    }
  };

  // 兼容问卷响应：提交会隐式批准该 eval，答案由主进程等当前回合结束后安全续发。
  const handleQuestionnaire = async (
    requestId: string,
    action: 'submit' | 'deny',
    answers?: QuestionnaireAnswer[]
  ) => {
    if (!selectedSession) {
      return false;
    }
    const sessionId = selectedSession.id;
    const requestExists = (questionnaireBySession.current[sessionId] ?? []).some(
      (request) => request.requestId === requestId
    );
    if (!requestExists) {
      return false;
    }
    const updateRecord = (
      status: NonNullable<ChatMessage['elicitationStatus']>,
      resultText: string
    ) => {
      const updateMessages = (current: ChatMessage[]) => current.map((message) =>
        message.elicitationRequestId === requestId
          ? { ...message, elicitationStatus: status, elicitationResult: resultText }
          : message
      );
      if (selectedSessionRef.current?.id === sessionId) {
        setMessages((current) => {
          const next = updateMessages(current);
          messageCache.current[sessionId] = next;
          return next;
        });
      } else {
        messageCache.current[sessionId] = updateMessages(messageCache.current[sessionId] ?? []);
      }
    };
    if (action === 'submit') {
      updateRecord('submitting', '已提交选择，正在完成当前步骤…');
      if (selectedSessionRef.current?.id === sessionId) setAgentStatus('正在提交问卷答案');
    }
    const result = await window.ohMyPiDesktop.questionnaireResponse(requestId, action, answers);
    if (!result.ok) {
      // 主进程区分两种失败原因：
      // - 'stale'：pending 请求已不存在，应清理失效队首并推进下一项，否则会卡住同 session 后续问卷；
      // - 'invalid-answers'：答案校验未通过但请求仍有效，保留队列让用户修改后重试；
      // - 其他未知原因保守保留，避免丢失可能仍有效的问卷。
      if (result.reason === 'stale') {
        updateRecord('failed', '问卷请求已失效');
        advanceToNextQuestionnaire(requestId, sessionId);
        if (selectedSessionRef.current?.id === sessionId) {
          const next = questionnaireBySession.current[sessionId]?.[0];
          setAgentStatus(next ? '等待选择' : '继续运行');
        }
        return false;
      }
      updateRecord('failed', result.message ?? '问卷提交失败，请重新选择');
      if (selectedSessionRef.current?.id === sessionId) setAgentStatus('问卷提交失败');
      return false;
    }
    // 成功路径（含 deny）：把请求从队列移除并推进弹窗到下一项。
    advanceToNextQuestionnaire(requestId, sessionId);
    if (action === 'deny') {
      updateRecord('declined', '已拒绝问卷');
    }
    if (selectedSessionRef.current?.id === sessionId) {
      setAgentStatus(action === 'submit' ? '已提交选择，等待当前步骤完成' : '已拒绝问卷');
    }
    return true;
  };


  // 粘贴图片时，FileReader 读取为 dataURL 走 handleAttachAttachment（统一判定与校验）。
  // 仅处理图片项，文件粘贴场景边缘，不扩大范围避免引入未验证行为。
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items);
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    if (!imageItem) {
      return;
    }
    const file = imageItem.getAsFile();
    if (!file) {
      return;
    }
    event.preventDefault();
    handleAttachAttachment(file);
  };

  const layoutClassName = [
    'layout-grid',
    resizingSide ? 'is-resizing' : ''
  ].filter(Boolean).join(' ');
  const appShellClassName = [
    'app-shell',
    leftCollapsed ? 'left-pane-collapsed' : '',
    resizingSide ? 'is-resizing' : ''
  ].filter(Boolean).join(' ');
  const layoutStyle = {
    '--left-pane-width': `${leftCollapsed ? 0 : leftPaneWidth}px`,
    '--right-pane-width': `${rightCollapsed ? 0 : rightPaneWidth}px`
  } as CSSProperties;
  const leftHandleClassName = [
    'pane-resize-handle',
    'left',
    resizingSide === 'left' ? 'active' : '',
    collapsePreviewSide === 'left' ? 'will-collapse' : ''
  ].filter(Boolean).join(' ');
  const rightHandleClassName = [
    'pane-resize-handle',
    'right',
    resizingSide === 'right' ? 'active' : '',
    collapsePreviewSide === 'right' ? 'will-collapse' : ''
  ].filter(Boolean).join(' ');
  const leftPreviewClassName = leftPreviewOpen ? 'left-preview-panel open' : 'left-preview-panel';

  return (
    <main className={appShellClassName} style={layoutStyle}>
      {!leftCollapsed && (
        <ProjectPane
          onTogglePane={collapseLeftPane}
          desktopState={desktopState}
          projects={displayedProjects}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          sessionsForProject={sessionsForProject}
          expandedProjectPaths={expandedProjectPaths}
          onSelectWorkspace={() => void handleSelectWorkspace()}
          onToggleProjectExpanded={toggleProjectExpanded}
          onNewSession={() => void handleNewSession()}
          onNewProjectSession={(project) => void handleNewSession(project)}
          onOpenSessionSearch={() => setSessionSearchOpen(true)}
          onSyncSessions={() => selectedProject && void syncProjectSessions(selectedProject.path)}
          onSelectProjectSession={(project, session) => void handleSelectProjectSession(project, session)}
          onToggleProjectPinned={(project) => void handleToggleProjectPinned(project)}
          onRevealProject={(project) => void handleRevealProject(project)}
          onRenameProject={(project, name) => void handleRenameProject(project, name)}
          onRemoveProject={(project) => void handleRemoveProject(project)}
          onForkSession={(project, session) => void handleForkSession(project, session)}
          onCloseSession={(project, session) => void handleCloseSession(session)}
        />
      )}
      {leftCollapsed && (
        <button
          className="left-pane-restore-button"
          type="button"
          onClick={expandLeftPane}
          aria-label="展开左侧项目栏"
          title="展开左侧项目栏"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 6l2 2-2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <TopBar
        projectName={selectedProject?.name}
        sessionTitle={selectedSession?.title}
        ompStatus={ompStatus}
        ompPath={ompPath}
        leftCollapsed={leftCollapsed}
        rightCollapsed={rightCollapsed}
        onToggleLeftPane={toggleLeftPane}
        onToggleRightPane={toggleRightPane}
        onSelectOmpPath={() => void handleSelectOmpPath()}
        onSelectWorkspace={() => void handleSelectWorkspace()}
      />
      <section className={layoutClassName}>
        <ChatWorkspace
          messages={messages}
          prompt={prompt}
          pendingAttachments={pendingAttachments}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          canCancel={isAgentBusy}
          availableCommands={displayedCommands}
          pendingSlashCommand={pendingSlashCommand}
          collapsedToolGroups={collapsedToolGroups}
          isHistoryLoading={loadingHistorySessionId === selectedSession?.id}
          historyScrollResetToken={historyScrollResetToken}
          elicitationRequests={elicitationBySession.current[selectedSession?.id ?? ''] ?? []}
          modelConfig={modelConfig}
          modeConfig={modeConfig}
          thinkingConfig={thinkingConfig}
          approvalProfile={currentApprovalProfile}
          approvalProfileNotice={approvalProfileNotice}
          isDraftSession={!selectedSession}
          onModelChange={(modelId) => void handleModelChange(modelId)}
          onModeChange={(modeId) => void handleModeChange(modeId)}
          onThinkingChange={(thinkingId) => void handleThinkingChange(thinkingId)}
          onApprovalProfileChange={(approvalProfile) =>
            void handleApprovalProfileChange(approvalProfile)
          }
          onPromptChange={setPrompt}
          onRemovePendingAttachment={(index) =>
            setPendingAttachments((current) => current.filter((_, idx) => idx !== index))
          }
          onSelectFile={handleSelectFile}
          onPaste={handlePaste}
          onSubmit={(event) => void handleSubmit(event)}
          onCancel={() => void handleCancelTurn()}
          onElicitationRespond={(requestId, action, content) => void handleElicitation(requestId, action, content)}
          onSetToolGroupCollapsed={(groupId, collapsed) =>
            handleSetToolGroupCollapsed(groupId, collapsed)
          }
        />

        {!rightCollapsed && (
          <ContextPane
            selectedProject={selectedProject}
            diffText={diffText}
            diffStatus={diffStatus}
            gitBranches={gitBranches}
            currentGitBranch={currentGitBranch}
            gitBranchNotice={gitBranchNotice}
            switchingGitBranch={switchingGitBranch}
            reviewSource={reviewSource}
            onGitBranchChange={(branchName) => void handleGitBranchChange(branchName)}
            onReviewSourceChange={(source) => void handleReviewSourceChange(source)}
            onSyncGitReview={syncGitReview}
            onRefreshReview={() => void handleRefreshGitReview()}
          />
        )}
        {!rightCollapsed && (
          <div
            className={rightHandleClassName}
            role="separator"
            aria-label="调整右侧上下文栏宽度"
            aria-orientation="vertical"
            title={collapsePreviewSide === 'right' ? '松开将折叠' : '拖拽调整右侧上下文栏宽度，双击折叠'}
            onMouseDown={(event) => startPaneResize('right', event)}
            onDoubleClick={collapseRightPane}
          />
        )}
      </section>
      {!leftCollapsed && (
        <div
          className={leftHandleClassName}
          role="separator"
          aria-label="调整左侧项目栏宽度"
          aria-orientation="vertical"
          title={collapsePreviewSide === 'left' ? '松开将折叠' : '拖拽调整左侧项目栏宽度，双击折叠'}
          onMouseDown={(event) => startPaneResize('left', event)}
          onDoubleClick={collapseLeftPane}
        />
      )}
      {leftCollapsed && (
        <div
          className="left-preview-hotzone"
          onMouseEnter={openLeftPreviewLater}
          onMouseLeave={closeLeftPreviewLater}
          onDoubleClick={expandLeftPane}
          aria-hidden="true"
        />
      )}
      {leftCollapsed && leftPreviewMounted && (
        <div
          className={leftPreviewClassName}
          onMouseEnter={keepLeftPreviewOpen}
          onMouseLeave={closeLeftPreviewLater}
        >
          <ProjectPane
            variant="preview"
            onClosePreview={closeLeftPreview}
            desktopState={desktopState}
            projects={displayedProjects}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            sessionsForProject={sessionsForProject}
            expandedProjectPaths={expandedProjectPaths}
            onSelectWorkspace={() => {
              closeLeftPreview();
              void handleSelectWorkspace();
            }}
            onToggleProjectExpanded={toggleProjectExpanded}
            onNewSession={() => {
              closeLeftPreview();
              void handleNewSession();
            }}
            onNewProjectSession={(project) => {
              closeLeftPreview();
              void handleNewSession(project);
            }}
            onOpenSessionSearch={() => {
              closeLeftPreview();
              setSessionSearchOpen(true);
            }}
            onSyncSessions={() => {
              closeLeftPreview();
              if (selectedProject) {
                void syncProjectSessions(selectedProject.path);
              }
            }}
            onSelectProjectSession={(project, session) => {
              closeLeftPreview();
              void handleSelectProjectSession(project, session);
            }}
            onToggleProjectPinned={(project) => {
              closeLeftPreview();
              void handleToggleProjectPinned(project);
            }}
            onRevealProject={(project) => {
              closeLeftPreview();
              void handleRevealProject(project);
            }}
            onRenameProject={(project, name) => {
              closeLeftPreview();
              void handleRenameProject(project, name);
            }}
            onRemoveProject={(project) => {
              closeLeftPreview();
              void handleRemoveProject(project);
            }}
            onForkSession={(project, session) => {
              closeLeftPreview();
              void handleForkSession(project, session);
            }}
            onCloseSession={(project, session) => {
              closeLeftPreview();
              void handleCloseSession(session);
            }}
          />
        </div>
      )}

      <StatusBar selectedProject={selectedProject} hasDiff={Boolean(diffText)} />

      {sessionSearchOpen && (
        <SessionSearchModal
          items={sessionSearchItems}
          currentProjectPath={selectedProject?.path}
          onClose={() => setSessionSearchOpen(false)}
          onSelect={(project, session) => void handleSelectProjectSession(project, session)}
        />
      )}

      {gitBranchSwitchError && (
        <GitBranchSwitchErrorModal error={gitBranchSwitchError} onClose={closeGitBranchSwitchError} />
      )}

      {activeApprovalKind === 'permission' && permissionRequest && (
        <PermissionModal request={permissionRequest} onRespond={(optionId) => void handlePermission(optionId)} />
      )}

      {activeApprovalKind === 'elicitation' && elicitationRequest && (
        <ElicitationModal
          request={elicitationRequest}
          onRespond={(action, content) => void handleElicitation(elicitationRequest.requestId, action, content)}
        />
      )}

      {activeApprovalKind === 'questionnaire' && questionnaireRequest && (
        <QuestionnaireModal
          key={questionnaireRequest.requestId}
          request={questionnaireRequest}
          requests={questionnaireBySession.current[selectedSession?.id ?? ''] ?? []}
          onSelect={setQuestionnaireRequest}
          onRespond={(action, answers) => handleQuestionnaire(questionnaireRequest.requestId, action, answers)}
        />
      )}

    </main>
  );
}
