/**
 * ChatWorkspace — 中间对话工作区组件。
 *
 * 渲染消息流（按回合分组、工具组折叠、Markdown 渲染）和底部输入区（textarea、
 * slash 命令面板、附件预览、模型/模式/推理强度/审批档位配置入口、加号菜单）。
 *
 * ## 渲染隔离设计
 * - MemoizedMessageStream 将消息历史区与受控输入区隔离；prompt 变化时仅更新 composer，
 *   不重新渲染历史消息 DOM。
 * - 消息叶子组件（ToolCallCard / PlanCard / SimpleMessage / MarkdownContent /
 *   ElicitationMessage / MessageRenderer）均通过 React.memo 包裹，同一消息 props
 *   不变时跳过渲染。
 * - Markdown 插件数组和组件映射提升为模块级常量，避免每次渲染重建。
 * - 审批响应、计划定位、滚动回调通过 useCallback + ref 稳定化，不破坏 memo 链。
 *
 * ## 维护
 * - 新增消息角色时更新 MessageRenderer 分发分支。
 * - 修改 Markdown 渲染行为时注意 MemoizedMarkdownContent 的比较策略。
 * - 回合 / 工具组折叠状态走 expandedProcesses（本地 useState）和
 *   collapsedToolGroups（App 下传）；切 session 时自动清空。
 */
import React, {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FormEvent, ClipboardEvent, KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { ElicitationModal } from './ElicitationModal';
import { ModelPickerPopover } from './ModelPickerPopover';
import { PermissionModal } from './PermissionModal';
import { QuestionnaireModal } from './QuestionnaireModal';
import { SegmentSelect } from './SegmentSelect';
import type {
  AcpConfigOption,
  ChatMessage,
  ElicitationRequest,
  PermissionRequest,
  PlanEntry,
  QuestionnaireAnswer,
  QuestionnaireRequest,
  ToolCallDiffBlock,
  ToolCallLocation,
  ToolKind,
  ToolCallStatus,
} from '../types';
import './ChatWorkspace.css';
import './Composer.css';

// 待执行 slash 命令卡片：由 App 在用户按发送时立即插入、由 onAgentEvent 首个回复事件清除。
type PendingSlashCommand = {
  id: string;
  name: string;
  args: string;
  sentAt: string;
  icon: string;
  label: string;
};

// OMP 会让同一条 assistant 消息的思考与正文复用 messageId，渲染身份需同时包含角色。
const getMessageRenderKey = (message: ChatMessage) => `${message.role}:${message.id}`;

// 待发送的附件（渲染端独立定义，与主进程类型不共享）。kind 决定 chip 展示样式。
type PendingAttachment = {
  dataUrl: string;
  fileName: string;
  kind: 'image' | 'text' | 'unsupported';
};

type ChatWorkspaceProps = {
  messages: ChatMessage[];
  prompt: string;
  pendingAttachments: PendingAttachment[];
  selectedProject: StoredProject | null;
  selectedSession: StoredSession | null;
  canCancel: boolean;
  // ACP `available_commands_update` 同步过来的 slash 命令列表。
  availableCommands: AcpAvailableCommand[];
  // 由 App 维护、当前选中 session 的"正在执行 slash 命令"卡片（null 表示无）。
  pendingSlashCommand: PendingSlashCommand | null;
  // 工具组折叠 map：key = 该工具组最后一条 tool 消息的 id。
  // true = 折叠成摘要卡、false = 用户主动展开、undefined = 从未操作（默认折叠）。
  collapsedToolGroups: Record<string, boolean | undefined>;
  // 会话历史回放期间显示加载占位，避免把空缓存误当成空会话。
  isHistoryLoading: boolean;
  // 历史消息完成渲染后递增，用于把消息区定位到顶部。
  historyScrollResetToken: number;
  // 当前审批队首由 App 的 activeApprovalKind 选择；消息流仅展示对应状态。
  activeApprovalRequestId: string | null;
  permissionRequest: PermissionRequest | null;
  elicitationRequest: ElicitationRequest | null;
  questionnaireRequest: QuestionnaireRequest | null;
  questionnaireRequests: QuestionnaireRequest[];
  // 会话配置（与 composer 同处）：模型 / Agent 模式 / 推理强度 / 审批档位。
  // ACP 三项配置与桌面端审批档位都位于输入框纸飞机按钮左侧。
  modelConfig?: AcpConfigOption;
  modeConfig?: AcpConfigOption;
  thinkingConfig?: AcpConfigOption;
  approvalProfile: ApprovalProfile;
  approvalProfileNotice: string;
  isDraftSession: boolean;
  onModelChange: (modelId: string) => void;
  onModeChange: (modeId: string) => void;
  onThinkingChange: (thinkingId: string) => void;
  onApprovalProfileChange: (approvalProfile: ApprovalProfile) => void;
  onPromptChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  onPermissionRespond: (optionId: string) => Promise<void>;
  onElicitationRespond: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ) => void;
  onSelectQuestionnaire: (request: QuestionnaireRequest) => void;
  onQuestionnaireRespond: (
    action: 'submit' | 'deny',
    answers?: QuestionnaireAnswer[],
  ) => Promise<boolean>;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemovePendingAttachment: (index: number) => void;
  // 点击加号菜单的「添加文件」时触发，由 App 打开系统文件选择器（accept 不限）。
  onSelectFile: () => void;
  // 用户点击工具组摘要卡时通知 App 切换折叠状态。
  onSetToolGroupCollapsed: (groupId: string, collapsed: boolean) => void;
};

/* 已有专属入口、不在命令面板里重复出现的命令：
   model/models/switch → 顶栏「模型选择器」；resume → 左栏会话恢复。 */
const HIDDEN_COMMANDS = new Set(['model', 'models', 'switch', 'resume']);
const APPROVAL_PROFILE_OPTIONS: NonNullable<AcpConfigOption['options']> = [
  { value: 'always-ask', name: '请求批准' },
  { value: 'write', name: '自动编辑' },
  { value: 'yolo', name: '完全访问' },
];

/* ToolKind → 图标 + 中文标签 */
const TOOL_KIND_META: Record<ToolKind, { icon: string; label: string }> = {
  read: { icon: '\u{1F4D6}', label: '读取' },
  edit: { icon: '\u{270F}\u{FE0F}', label: '编辑' },
  delete: { icon: '\u{1F5D1}\u{FE0F}', label: '删除' },
  move: { icon: '\u{1F4C2}', label: '移动' },
  search: { icon: '\u{1F50D}', label: '搜索' },
  execute: { icon: '\u{26A1}', label: '执行' },
  think: { icon: '\u{1F9E0}', label: '思考' },
  fetch: { icon: '\u{1F310}', label: '请求' },
  switch_mode: { icon: '\u{1F504}', label: '切换' },
  other: { icon: '\u{1F527}', label: '工具' },
};

/* ToolCallStatus → 中文 + 颜色类 */
const STATUS_META: Record<ToolCallStatus, { label: string; cssClass: string }> = {
  pending: { label: '等待中', cssClass: 'status-pending' },
  in_progress: { label: '执行中', cssClass: 'status-running' },
  completed: { label: '已完成', cssClass: 'status-done' },
  failed: { label: '失败', cssClass: 'status-error' },
};

/* PlanEntryStatus → 中文 */
const PLAN_STATUS_LABEL: Record<PlanEntry['status'], string> = {
  pending: '\u25CB',
  in_progress: '\u25D0',
  completed: '\u25CF',
};

// 距底部小于该距离时认为用户没有主动离开最新消息，流式更新可以继续跟随到底部。
const AUTO_SCROLL_BOTTOM_THRESHOLD = 96;

const SUPERSEDED_READ_OUTPUT = '[Superseded by a newer read of this file]';

// 仅压缩 ACP 明确标记为被后续读取替代的失败记录，其他失败始终保留供排查。
const isSupersededRead = (message: ChatMessage) =>
  message.toolKind === 'read' &&
  message.toolStatus === 'failed' &&
  message.toolOutput?.trim() === SUPERSEDED_READ_OUTPUT;

/* -------------------------------------------------------
 * 子组件：结构化消息渲染
 * ------------------------------------------------------- */

/* 工具调用条目 */
function ToolCallCard({ message }: { message: ChatMessage }) {
  const kind = message.toolKind ?? 'other';
  const meta = TOOL_KIND_META[kind];
  const status = message.toolStatus;
  const statusMeta = status ? STATUS_META[status] : null;
  const [isToolOutputOpen, setIsToolOutputOpen] = useState(status !== 'completed');
  const hasUserToggledToolOutput = useRef(false);

  useEffect(() => {
    if (!hasUserToggledToolOutput.current) {
      setIsToolOutputOpen(status !== 'completed');
    }
  }, [status]);

  return (
    <article className={`message tool tool-card tool-${kind}`} key={message.id}>
      <div className="tool-card-header">
        <span className="tool-icon">{meta.icon}</span>
        <span className="tool-kind-label">{meta.label}</span>
        {statusMeta && (
          <span className={`tool-status ${statusMeta.cssClass}`}>
            {(status === 'pending' || status === 'in_progress') && (
              <span className="tool-spinner" aria-hidden="true" />
            )}
            {statusMeta.label}
          </span>
        )}
        {message.toolModel && (
          <span className="tool-model" title={`模型：${message.toolModel.id}`}>
            {message.toolModel.name}
          </span>
        )}
        {message.text && <span className="tool-title">{message.text}</span>}
      </div>
      {message.toolLocations && message.toolLocations.length > 0 && (
        <div className="tool-locations">
          {message.toolLocations.map((loc: ToolCallLocation, i: number) => (
            <span className="tool-file" key={`${loc.path}-${i}`}>
              {loc.path}
              {loc.line != null ? `:${loc.line}` : ''}
            </span>
          ))}
        </div>
      )}
      {message.toolDiffs && message.toolDiffs.length > 0 && (
        <div className="tool-diffs">
          {message.toolDiffs.map((diff: ToolCallDiffBlock, i: number) => (
            <details className="tool-diff-block" key={`diff-${i}`}>
              <summary>diff: {diff.path ?? 'unknown'}</summary>
              <pre className="diff-content">
                <code>{`--- ${diff.path ?? 'unknown'}\n${diff.oldText ?? ''}\n+++ ${diff.path ?? 'unknown'}\n${diff.newText ?? ''}`}</code>
              </pre>
            </details>
          ))}
        </div>
      )}
      {message.toolOutput && (
        <details
          className="tool-output"
          open={isToolOutputOpen}
          onToggle={(event) => {
            hasUserToggledToolOutput.current = true;
            setIsToolOutputOpen(event.currentTarget.open);
          }}
        >
          <summary>输出</summary>
          <pre className="tool-output-content">
            <code>{message.toolOutput}</code>
          </pre>
        </details>
      )}
    </article>
  );
}

const MemoizedToolCallCard = React.memo(ToolCallCard);

/* 计划记录：摘要始终留在消息流中，完整内容按需展开。 */
function PlanCard({ message }: { message: ChatMessage }) {
  if (message.planPending) {
    return (
      <article
        id={`plan-message-${message.id}`}
        className="message plan plan-loading"
        key={message.id}
      >
        <div className="plan-header">
          <span className="plan-loading-dot" aria-hidden="true" />
          正在创建计划
        </div>
        <div className="plan-loading-body">{message.text}</div>
      </article>
    );
  }

  if (message.planContentType === 'markdown') {
    return (
      <details
        id={`plan-message-${message.id}`}
        className="message plan"
        key={message.id}
        open={message.planPreview || message.planActive || undefined}
      >
        <summary className="plan-header">
          <span className="plan-heading">
            <span className="plan-caret" aria-hidden="true">
              ▸
            </span>
            {'📋'}{' '}
            {message.planActive
              ? '当前未完成方案'
              : message.planPreview
                ? '待确认方案'
                : '方案文档'}
          </span>
        </summary>
        {message.planPreviewDegraded && (
          <div className="plan-degraded-hint">
            ⚠️ 未能加载完整方案，以下为摘要，完整内容请查看弹窗或在终端确认。
          </div>
        )}
        <div className="plan-document">
          <MemoizedMarkdownContent text={message.text} />
        </div>
      </details>
    );
  }

  if (message.planContentType === 'file') {
    return (
      <details
        id={`plan-message-${message.id}`}
        className="message plan"
        key={message.id}
        open={message.planPreview || message.planActive || undefined}
      >
        <summary className="plan-header">
          <span className="plan-heading">
            <span className="plan-caret" aria-hidden="true">
              ▸
            </span>
            {'📋'} 计划文件
          </span>
        </summary>
        <div className="plan-document">
          <code>{message.text}</code>
        </div>
      </details>
    );
  }

  const entries = message.planEntries;
  if (!entries || entries.length === 0) {
    return (
      <article
        id={`plan-message-${message.id}`}
        className="message plan plan-empty"
        key={message.id}
      >
        <div className="plan-header">{'\u{1F4CB}'} 计划已清空</div>
      </article>
    );
  }

  const completed = entries.filter((entry: PlanEntry) => entry.status === 'completed').length;
  const total = entries.length;

  return (
    <details id={`plan-message-${message.id}`} className="message plan" key={message.id}>
      <summary className="plan-header">
        <span className="plan-heading">
          <span className="plan-caret" aria-hidden="true">
            ▸
          </span>
          {'\u{1F4CB}'} 执行计划
        </span>
        <span className="plan-progress">
          {completed}/{total}
        </span>
      </summary>
      <ol className="plan-entries">
        {entries.map((entry: PlanEntry, i: number) => (
          <li key={i} className={`plan-entry plan-${entry.status}`}>
            <span className="plan-status-icon">{PLAN_STATUS_LABEL[entry.status]}</span>
            <span className="plan-entry-content">{entry.content}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

const MemoizedPlanCard = React.memo(PlanCard);

type PlanStatusBarProps = {
  messages: ChatMessage[];
  onLocate: (messageId: string) => void;
};

const ApprovalRequestContext = React.createContext<string | null>(null);
/* 计划状态行占据消息流顶部的真实布局空间，不覆盖右对齐的用户消息。 */
function PlanStatusBar({ messages, onLocate }: PlanStatusBarProps) {
  const latest = messages[messages.length - 1];
  const entries = latest.planEntries ?? [];
  const completed = entries.filter((entry) => entry.status === 'completed').length;
  const label = latest.planPending
    ? '正在创建计划'
    : latest.planActive
      ? '当前未完成方案'
      : latest.planPreview
        ? '待确认方案'
        : latest.planContentType === 'markdown'
          ? '方案文档'
          : `执行计划${entries.length > 0 ? ` · ${completed}/${entries.length}` : ''}`;

  return (
    <aside className="plan-status-slot">
      {latest.planPending ? (
        <div className="plan-status-control plan-status-pending" aria-live="polite">
          <span className="plan-loading-dot" aria-hidden="true" />
          <span>{label}</span>
        </div>
      ) : (
        <button
          type="button"
          className="plan-status-control"
          onClick={() => onLocate(latest.id)}
          title="定位到消息流中的计划摘要"
        >
          <span>{label}</span>
          <span className="plan-status-locate">查看</span>
        </button>
      )}
    </aside>
  );
}
/* 复制图标 SVG：两个重叠矩形 */
function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/* 已复制勾选图标 SVG */
function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/* 代码块容器：在右上角添加复制按钮。用 ref 提取 <pre> 文本内容复制到剪贴板。 */
function CodeBlock(props: React.ComponentProps<'pre'>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? '';
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  return (
    <div className="code-block-wrapper">
      <button
        type="button"
        className="code-copy-btn"
        onClick={handleCopy}
        title={copied ? '已复制' : '复制代码'}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <pre ref={preRef} {...props} />
    </div>
  );
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_REHYPE_PLUGINS = [rehypeHighlight];
const MARKDOWN_COMPONENTS = { pre: CodeBlock };

/* Markdown 渲染组件：用于 user / agent 文本消息，支持 GFM（表格/删除线/任务列表）。
   rehype-highlight 按 fenced code 的语言标识自动注入 .hljs-* token，配色见
   highlight-themes/*.css。react-markdown 默认不解析原始 HTML，安全无需额外处理。 */
function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

const MemoizedMarkdownContent = React.memo(MarkdownContent);

/* 状态 / 错误 / 用户 / 思考 / Agent 文本消息 */
function SimpleMessage({ message }: { message: ChatMessage }) {
  const isStatus = message.role === 'status';
  const useMarkdown =
    message.role === 'user' || message.role === 'thought' || message.role === 'agent';
  const [copyMsgDone, setCopyMsgDone] = useState(false);

  const handleCopyMessage = useCallback(() => {
    void navigator.clipboard.writeText(message.text).then(() => {
      setCopyMsgDone(true);
      setTimeout(() => setCopyMsgDone(false), 2000);
    });
  }, [message.text]);

  return (
    <article className={`message ${message.role}`} key={message.id}>
      {useMarkdown ? <MemoizedMarkdownContent text={message.text} /> : <p>{message.text}</p>}
      {!isStatus && (
        <button
          type="button"
          className="msg-copy-btn"
          onClick={handleCopyMessage}
          title={copyMsgDone ? '已复制' : '复制全文'}
        >
          {copyMsgDone ? <CheckIcon /> : <CopyIcon />}
        </button>
      )}
    </article>
  );
}

const MemoizedSimpleMessage = React.memo(SimpleMessage);

/* elicitation 记录：审批操作统一由下方审批坞承载，消息流只保留请求与结果。 */
function ElicitationMessage({ message }: { message: ChatMessage }) {
  const activeApprovalRequestId = React.useContext(ApprovalRequestContext);
  const time = message.createdAt
    ? new Date(message.createdAt).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  const isPending = message.elicitationStatus === 'pending';
  const isResolved =
    message.elicitationStatus === 'accepted' ||
    message.elicitationStatus === 'declined' ||
    message.elicitationStatus === 'cancelled';
  const isQuestionnaire = message.elicitationKind === 'questionnaire';
  const isQuestion = message.elicitationKind === 'question';
  const title = isPending
    ? isQuestionnaire || isQuestion
      ? '等待选择'
      : '等待确认'
    : message.elicitationStatus === 'submitting'
      ? isQuestionnaire || isQuestion
        ? '正在提交选择'
        : '正在提交确认'
      : message.elicitationStatus === 'failed'
        ? isQuestionnaire
          ? '问卷提交失败'
          : isQuestion
            ? '回答提交失败'
            : '确认失败'
        : isQuestion
          ? '问答记录'
          : '确认记录';
  const pendingHint =
    message.elicitationRequestId === activeApprovalRequestId
      ? '请在下方审批坞处理。'
      : '已进入审批队列，等待前一项处理完成。';

  return (
    <article
      className={`message elicitation elicitation-${message.elicitationStatus ?? 'pending'}${isResolved ? ' elicitation-resolved' : ''}`}
    >
      {isResolved ? (
        <div className="elicitation-resolved-row">
          <span className="elicitation-title">{title}</span>
          <span className="elicitation-resolved-question">{message.text}</span>
          {message.elicitationResult && (
            <span className="elicitation-resolved-result">{message.elicitationResult}</span>
          )}
          {time && <time dateTime={message.createdAt}>{time}</time>}
        </div>
      ) : (
        <>
          <header className="elicitation-header">
            <span className="elicitation-title">{title}</span>
            {time && <time dateTime={message.createdAt}>{time}</time>}
          </header>
          <p className="elicitation-question">{message.text}</p>
          {isPending && <p className="elicitation-pending-hint">{pendingHint}</p>}
          {message.elicitationResult && (
            <p className="elicitation-result">{message.elicitationResult}</p>
          )}
        </>
      )}
    </article>
  );
}

type ApprovalDockProps = Pick<
  ChatWorkspaceProps,
  | 'permissionRequest'
  | 'elicitationRequest'
  | 'questionnaireRequest'
  | 'questionnaireRequests'
  | 'onPermissionRespond'
  | 'onElicitationRespond'
  | 'onSelectQuestionnaire'
  | 'onQuestionnaireRespond'
>;

function ApprovalDock({
  permissionRequest,
  elicitationRequest,
  questionnaireRequest,
  questionnaireRequests,
  onPermissionRespond,
  onElicitationRespond,
  onSelectQuestionnaire,
  onQuestionnaireRespond,
}: ApprovalDockProps) {
  const hasRequest = Boolean(permissionRequest || elicitationRequest || questionnaireRequest);

  if (!hasRequest) return null;

  return (
    <aside className="approval-dock" aria-label="审批坞">
      {permissionRequest ? (
        <PermissionModal request={permissionRequest} onRespond={onPermissionRespond} />
      ) : elicitationRequest ? (
        <ElicitationModal
          request={elicitationRequest}
          onRespond={(action, content) =>
            onElicitationRespond(elicitationRequest.requestId, action, content)
          }
        />
      ) : questionnaireRequest ? (
        <QuestionnaireModal
          key={questionnaireRequest.requestId}
          request={questionnaireRequest}
          requests={questionnaireRequests}
          onSelect={onSelectQuestionnaire}
          onRespond={onQuestionnaireRespond}
        />
      ) : null}
    </aside>
  );
}

const MemoizedElicitationMessage = React.memo(ElicitationMessage);

/* 消息分发器：根据 role 和结构化字段选择渲染组件 */
function MessageRenderer({ message }: { message: ChatMessage }) {
  if (message.role === 'tool' && message.toolCallId) {
    return <MemoizedToolCallCard message={message} />;
  }
  if (message.role === 'plan') {
    return <MemoizedPlanCard message={message} />;
  }
  if (message.role === 'elicitation') {
    return <MemoizedElicitationMessage message={message} />;
  }
  return <MemoizedSimpleMessage message={message} />;
}

const MemoizedMessageRenderer = React.memo(MessageRenderer);

/* 工具组头部（折叠/展开态共用）：一行展示工具调用、已覆盖记录和实际错误数量。
   - 折叠态 caret=▶，点击展开整组；
   - 展开态 caret=▼，点击收起整组。 */
type ToolGroupHeaderProps = {
  groupId: string;
  count: number;
  supersededReadCount: number;
  hasError: boolean;
  expanded: boolean;
  onToggle: () => void;
};
function ToolGroupHeader({
  groupId: _groupId,
  count,
  supersededReadCount,
  hasError,
  expanded,
  onToggle,
}: ToolGroupHeaderProps) {
  return (
    <button
      type="button"
      className={`tool-group-header ${hasError ? 'tool-group-header-error' : ''}`}
      onClick={onToggle}
      title={expanded ? '点击收起这一组工具调用' : '点击展开这一组工具调用'}
    >
      <span className="tool-group-header-caret" aria-hidden="true">
        {expanded ? '▼' : '▶'}
      </span>
      <span className="tool-group-header-label">
        {count} 个工具调用
        {supersededReadCount > 0 ? ` · ${supersededReadCount} 项已覆盖` : ''}
        {hasError ? ' · 包含错误' : ''}
      </span>
    </button>
  );
}

function SupersededReadSummary({ count }: { count: number }) {
  return (
    <div className="tool-superseded-summary">
      <span className="tool-superseded-summary-icon" aria-hidden="true">
        ↳
      </span>
      <span>{count} 次读取已被后续操作覆盖</span>
    </div>
  );
}

type ToolGroupItem =
  | { kind: 'tool'; message: ChatMessage }
  | { kind: 'supersededReadSummary'; id: string; count: number };

type CompactToolGroup = {
  items: ToolGroupItem[];
  supersededReadCount: number;
};

function compactToolGroupMessages(messages: ChatMessage[]): CompactToolGroup {
  const items: ToolGroupItem[] = [];
  let supersededReadCount = 0;
  let totalSupersededReadCount = 0;
  let firstSupersededReadId = '';

  const flushSupersededReads = () => {
    if (supersededReadCount === 0) {
      return;
    }
    items.push({
      kind: 'supersededReadSummary',
      id: firstSupersededReadId,
      count: supersededReadCount,
    });
    supersededReadCount = 0;
    firstSupersededReadId = '';
  };

  for (const message of messages) {
    if (isSupersededRead(message)) {
      if (supersededReadCount === 0) {
        firstSupersededReadId = message.id;
      }
      supersededReadCount += 1;
      totalSupersededReadCount += 1;
      continue;
    }
    flushSupersededReads();
    items.push({ kind: 'tool', message });
  }
  flushSupersededReads();

  return { items, supersededReadCount: totalSupersededReadCount };
}

/* 消息段类型：单条消息 或 连续 tool 消息组 */
type MessageSegment =
  | { kind: 'single'; message: ChatMessage }
  | {
      kind: 'toolGroup';
      groupId: string;
      messages: ChatMessage[];
      items: ToolGroupItem[];
      supersededReadCount: number;
    };
type MessageSequenceProps = {
  messages: ChatMessage[];
  collapsedToolGroups: Record<string, boolean | undefined>;
  onSetToolGroupCollapsed: (groupId: string, collapsed: boolean) => void;
};

/* 渲染一段消息序列：连续 tool 消息会被合并成可折叠的工具组，其余消息独立渲染。
   该组件同时用于「回合内的思考过程」和「回合外的独立消息」。 */
function MessageSequence({
  messages,
  collapsedToolGroups,
  onSetToolGroupCollapsed,
}: MessageSequenceProps) {
  const segments = useMemo<MessageSegment[]>(() => {
    const result: MessageSegment[] = [];
    let buffer: ChatMessage[] = [];
    const flush = () => {
      if (buffer.length === 0) {
        return;
      }
      const last = buffer[buffer.length - 1];
      const compacted = compactToolGroupMessages(buffer);
      result.push({
        kind: 'toolGroup',
        groupId: last.id,
        messages: buffer,
        items: compacted.items,
        supersededReadCount: compacted.supersededReadCount,
      });
      buffer = [];
    };
    for (const message of messages) {
      if (message.role === 'tool' && message.toolCallId) {
        buffer.push(message);
      } else {
        flush();
        result.push({ kind: 'single', message });
      }
    }
    flush();
    return result;
  }, [messages]);

  return (
    <>
      {segments.map((segment) => {
        if (segment.kind === 'single') {
          return (
            <MemoizedMessageRenderer
              key={getMessageRenderKey(segment.message)}
              message={segment.message}
            />
          );
        }
        const collapsed = collapsedToolGroups[segment.groupId] !== false;
        const hasError = segment.messages.some(
          (message) => message.toolStatus === 'failed' && !isSupersededRead(message),
        );
        return (
          <Fragment key={`tool-group-${segment.groupId}`}>
            <ToolGroupHeader
              groupId={segment.groupId}
              count={segment.messages.length}
              supersededReadCount={segment.supersededReadCount}
              hasError={hasError}
              expanded={!collapsed}
              onToggle={() => onSetToolGroupCollapsed(segment.groupId, !collapsed)}
            />
            {!collapsed &&
              segment.items.map((item) =>
                item.kind === 'tool' ? (
                  <MemoizedMessageRenderer
                    key={getMessageRenderKey(item.message)}
                    message={item.message}
                  />
                ) : (
                  <SupersededReadSummary key={`superseded-read-${item.id}`} count={item.count} />
                ),
              )}
          </Fragment>
        );
      })}
    </>
  );
}

type TurnBlockProps = {
  userMessage: ChatMessage;
  processMessages: ChatMessage[];
  isActive: boolean;
  expanded: boolean;
  onToggle: () => void;
  collapsedToolGroups: Record<string, boolean | undefined>;
  onSetToolGroupCollapsed: (groupId: string, collapsed: boolean) => void;
};

/* 一个「用户提问 → agent 思考过程 → agent 最终回答」的回合。
   - 用户消息始终展开。
   - 思考过程（thought / tool / 非最终 agent 输出）收进可折叠块。
   - 该回合的最后一条 agent 消息视为「最终回答」，始终展开。
   - 工具调用在思考过程内部仍可单独折叠/展开（双重折叠）。 */
function TurnBlock({
  userMessage,
  processMessages,
  isActive,
  expanded,
  onToggle,
  collapsedToolGroups,
  onSetToolGroupCollapsed,
}: TurnBlockProps) {
  const {
    finalAnswer,
    processOnly,
    tailMessages,
    elicitationMessages,
    planMessages,
    statusMessages,
  } = useMemo(() => {
    // 审批记录、计划与状态是用户需要看见的关键节点，始终放在思考折叠区外展示。
    const elicitationMessages = processMessages.filter((message) => message.role === 'elicitation');
    const planMessages = processMessages.filter((message) => message.role === 'plan');
    const statusMessages = processMessages.filter((message) => message.role === 'status');
    const ordinaryMessages = processMessages.filter(
      (message) =>
        message.role !== 'elicitation' && message.role !== 'plan' && message.role !== 'status',
    );
    if (isActive) {
      // 当前回合仍在流式输出时，agent 文本也归入折叠区，避免长输出持续占满中间栏。
      return {
        finalAnswer: null,
        processOnly: ordinaryMessages,
        tailMessages: [],
        elicitationMessages,
        planMessages,
        statusMessages,
      };
    }
    // 最终回答通常是最后一条 agent 消息；如果 agent 没有正常输出，error 消息作为回合同等重要的结果也始终展开。
    const lastFinalIndex = ordinaryMessages
      .map((message) => (message.role === 'agent' || message.role === 'error' ? 'final' : ''))
      .lastIndexOf('final');
    if (lastFinalIndex >= 0) {
      return {
        finalAnswer: ordinaryMessages[lastFinalIndex],
        processOnly: ordinaryMessages.slice(0, lastFinalIndex),
        tailMessages: ordinaryMessages.slice(lastFinalIndex + 1),
        elicitationMessages,
        planMessages,
        statusMessages,
      };
    }
    return {
      finalAnswer: null,
      processOnly: ordinaryMessages,
      tailMessages: [],
      elicitationMessages,
      planMessages,
      statusMessages,
    };
  }, [processMessages, isActive]);

  const summary = useMemo(() => {
    const toolCount = processOnly.filter((message) => message.role === 'tool').length;
    const thinkCount = processOnly.filter((message) => message.role === 'thought').length;
    const parts: string[] = [];
    if (toolCount > 0) parts.push(`${toolCount} 个工具调用`);
    if (thinkCount > 0) parts.push(`${thinkCount} 条思考`);
    return parts.length > 0 ? parts.join(' · ') : '无内容';
  }, [processOnly]);

  return (
    <div className="turn-block">
      <MemoizedMessageRenderer message={userMessage} />
      {processOnly.length > 0 && (
        <div className="turn-process">
          <button
            type="button"
            className="turn-process-header"
            onClick={onToggle}
            title={expanded ? '收起思考过程' : '展开思考过程'}
          >
            <span className="turn-process-caret" aria-hidden="true">
              {expanded ? '▼' : '▶'}
            </span>
            <span className="turn-process-label">
              {expanded ? '隐藏思考过程' : `思考过程（${summary}）`}
            </span>
          </button>
          {expanded && (
            <div className="turn-process-content">
              <MessageSequence
                messages={processOnly}
                collapsedToolGroups={collapsedToolGroups}
                onSetToolGroupCollapsed={onSetToolGroupCollapsed}
              />
            </div>
          )}
        </div>
      )}
      {planMessages.map((message) => (
        <MemoizedMessageRenderer key={getMessageRenderKey(message)} message={message} />
      ))}

      {statusMessages.map((message) => (
        <MemoizedMessageRenderer key={getMessageRenderKey(message)} message={message} />
      ))}
      {elicitationMessages.map((message) => (
        <MemoizedMessageRenderer key={getMessageRenderKey(message)} message={message} />
      ))}
      {finalAnswer && <MemoizedMessageRenderer message={finalAnswer} />}
      {tailMessages.length > 0 && (
        <MessageSequence
          messages={tailMessages}
          collapsedToolGroups={collapsedToolGroups}
          onSetToolGroupCollapsed={onSetToolGroupCollapsed}
        />
      )}
    </div>
  );
}

/* 待执行 slash 命令卡片：用户按下发送后立刻出现，omp 真正回包时被 onAgentEvent 清掉。
   args 截断到 30 字符避免长参数破坏布局；动画由 CSS keyframes 提供。 */
function CommandPendingCard({ pending }: { pending: PendingSlashCommand }) {
  const argsPreview = pending.args.length > 30 ? `${pending.args.slice(0, 30)}…` : pending.args;
  const title = argsPreview ? `/${pending.name} ${argsPreview}` : `/${pending.name}`;
  return (
    <article className="message command-pending" key={pending.id} aria-live="polite">
      <span className="command-pending-spinner" aria-hidden="true">
        {pending.icon}
      </span>
      <div className="command-pending-body">
        <span className="command-pending-name">{title}</span>
        <span className="command-pending-label">{pending.label}</span>
      </div>
    </article>
  );
}

type MessageStreamProps = {
  activePlanMessages: ChatMessage[];
  conversationMessages: ChatMessage[];
  messageItems: React.ReactNode;
  selectedProject: StoredProject | null;
  pendingSlashCommand: PendingSlashCommand | null;
  isHistoryLoading: boolean;
  messageListRef: React.RefObject<HTMLDivElement | null>;
  showScrollToBottom: boolean;
  onLocatePlan: (messageId: string) => void;
  onMessageListScroll: () => void;
  onScrollToBottom: () => void;
};

/* 计划状态槽位于滚动区上方，消息与输入区始终拥有各自的可用空间。 */
function MessageStream({
  activePlanMessages,
  conversationMessages,
  messageItems,
  selectedProject,
  pendingSlashCommand,
  isHistoryLoading,
  messageListRef,
  showScrollToBottom,
  onLocatePlan,
  onMessageListScroll,
  onScrollToBottom,
}: MessageStreamProps) {
  return (
    <div className="message-stream">
      {activePlanMessages.length > 0 && (
        <PlanStatusBar messages={activePlanMessages} onLocate={onLocatePlan} />
      )}
      <div
        ref={messageListRef}
        className="message-list"
        aria-live="polite"
        onScroll={onMessageListScroll}
      >
        {isHistoryLoading ? (
          <div className="welcome-message">
            <h1>正在加载历史会话</h1>
            <p>消息加载完成后会自动显示。</p>
          </div>
        ) : conversationMessages.length === 0 ? (
          <div className="welcome-message">
            <h1>向 oh-my-pi agent 说明你想做什么</h1>
            <p>{selectedProject ? '当前会话等待输入。' : '未选择项目。'}</p>
          </div>
        ) : (
          messageItems
        )}
        {/* 待执行 slash 命令卡片：用户已发送但 omp 尚未回包时显示在消息流末尾。 */}
        {pendingSlashCommand && <CommandPendingCard pending={pendingSlashCommand} />}
        {/* 滚动到底部浮动按钮：用户向上翻看历史时出现，点击回到最新消息并恢复跟随。 */}
        {showScrollToBottom && (
          <button
            className="scroll-to-bottom-btn"
            type="button"
            onClick={onScrollToBottom}
            aria-label="滚动到底部"
            title="滚动到底部"
          >
            ↓
          </button>
        )}
      </div>
    </div>
  );
}

const MemoizedMessageStream = React.memo(MessageStream);

export function ChatWorkspace({
  messages,
  prompt,
  pendingAttachments,
  selectedProject,
  selectedSession,
  canCancel,
  availableCommands,
  pendingSlashCommand,
  collapsedToolGroups,
  isHistoryLoading,
  historyScrollResetToken,
  activeApprovalRequestId,
  permissionRequest,
  elicitationRequest,
  questionnaireRequest,
  questionnaireRequests,
  modelConfig,
  modeConfig,
  thinkingConfig,
  approvalProfile,
  approvalProfileNotice,
  isDraftSession,
  onModelChange,
  onModeChange,
  onThinkingChange,
  onApprovalProfileChange,
  onPromptChange,
  onSubmit,
  onCancel,
  onPermissionRespond,
  onElicitationRespond,
  onSelectQuestionnaire,
  onQuestionnaireRespond,
  onPaste,
  onRemovePendingAttachment,
  onSelectFile,
  onSetToolGroupCollapsed,
}: ChatWorkspaceProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowMessagesRef = useRef(true);
  // 是否已离开消息流底部（用于显示「滚动到底部」浮动按钮）。
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // 用户按 Esc 主动收起面板；输入内容再变化时重新允许弹出。
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  // 加号菜单：点击按钮切换；点击按钮/菜单外部、或聚焦输入框时收起。
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachButtonRef = useRef<HTMLButtonElement | null>(null);
  const attachMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!attachMenuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!attachButtonRef.current?.contains(target) && !attachMenuRef.current?.contains(target)) {
        setAttachMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [attachMenuOpen]);

  // —— ACP 会话配置选择器（模型 / Agent 模式 / 推理强度）状态 ——
  // 这些选择器紧贴发送按钮左侧；模型选择器走自定义 Popover，
  // 其余两者复用 SegmentSelect。草稿会话（尚未创建 ACP session）下
  // 暂存到 App 的 draftConfigValues，首次发送时统一应用。
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const modelEmptyLabel = isDraftSession ? '发送后加载' : '模型未加载';
  const modeEmptyLabel = isDraftSession ? '发送后加载' : '模式未加载';
  const thinkingEmptyLabel = isDraftSession ? '发送后加载' : '推理强度未加载';
  const modelOptions = modelConfig?.options ?? [];
  const currentModelValue =
    typeof modelConfig?.currentValue === 'string' ? modelConfig.currentValue : '';
  const currentModelName =
    modelOptions.find((m) => m.value === currentModelValue)?.name ??
    (modelOptions.length === 0 ? modelEmptyLabel : '未选择模型');
  const modeOptions = modeConfig?.options ?? [];
  const currentMode = typeof modeConfig?.currentValue === 'string' ? modeConfig.currentValue : '';
  const thinkingOptions = thinkingConfig?.options ?? [];
  const currentThinking =
    typeof thinkingConfig?.currentValue === 'string' ? thinkingConfig.currentValue : '';
  // 每个回合（user → agent 思考过程 → agent 最终回答）的思考过程展开态。
  // key = `turn-<userMessage.id>`，value = true 表示展开。不持久化，切会话即清空。
  const [expandedProcesses, setExpandedProcesses] = useState<Record<string, boolean>>({});
  // 切换 session 时清空回合折叠状态并重置滚动跟随。
  useLayoutEffect(() => {
    setExpandedProcesses({});
    shouldFollowMessagesRef.current = true;
    setShowScrollToBottom(false);
  }, [selectedSession?.id]);

  const handleMessageListScroll = useCallback(() => {
    const el = messageListRef.current;
    const nearBottom =
      !el || el.scrollHeight - el.scrollTop - el.clientHeight <= AUTO_SCROLL_BOTTOM_THRESHOLD;
    shouldFollowMessagesRef.current = nearBottom;
    setShowScrollToBottom(!nearBottom);
  }, []);

  const handleLocatePlan = useCallback((messageId: string) => {
    document.getElementById(`plan-message-${messageId}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, []);

  // 命令触发：输入框内容形如 `/<token>`（以 / 开头、尚未输入空格）时，
  // 认为用户正在打命令名，token 即作为搜索词；一旦输入空格（开始填参数）则收起。
  const commandToken = useMemo(() => {
    const match = prompt.match(/^\/(\S*)$/);
    return match ? match[1].toLowerCase() : null;
  }, [prompt]);

  // 过滤掉已有专属入口的命令，再按当前 token 匹配 name / description。
  const visibleCommands = useMemo(() => {
    if (commandToken === null) {
      return [];
    }
    return availableCommands.filter(
      (command) =>
        !HIDDEN_COMMANDS.has(command.name) &&
        (commandToken === '' ||
          command.name.toLowerCase().includes(commandToken) ||
          command.description.toLowerCase().includes(commandToken)),
    );
  }, [availableCommands, commandToken]);

  // 面板是否展示：正在打命令名、且未被 Esc 收起（不再要求已有命令才弹出，
  //  新 session 可能在 ACP 下发命令前就输入 /，面板先弹出并引导用户了解机制）。
  const paletteOpen = commandToken !== null && !paletteDismissed;

  // 输入变化统一入口：透传给父级，并解除 Esc 的临时收起。
  const handlePromptChange = (value: string) => {
    setPaletteDismissed(false);
    onPromptChange(value);
  };

  // 键盘事件：Esc 收起命令面板；单独 Enter 发送消息；Shift+Enter 换行；Ctrl+Enter 无操作。
  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && paletteOpen) {
      event.preventDefault();
      setPaletteDismissed(true);
      return;
    }
    if (event.key === 'Enter') {
      // Ctrl+Enter 不换行也不发送。
      if (event.ctrlKey) {
        event.preventDefault();
        return;
      }
      // 单独 Enter（无修饰键、非 IME 组合态）触发表单提交。
      if (!event.shiftKey && !event.metaKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        formRef.current?.requestSubmit();
      }
      // Shift+Enter / Meta+Enter / IME 组合态：由浏览器处理换行。
    }
  };

  // 自动调整 textarea 高度：内容增多时先拉高，超过最大高度显示滚动条。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 240; // 约 10 行
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [prompt]);

  // 点击命令：把 `/<name> ` 填回输入框（方案乙），光标移到末尾；
  // 末尾空格会让触发条件失配，面板随即自动收起，由用户补参数后发送。
  const insertCommand = (name: string) => {
    setPaletteDismissed(false);
    onPromptChange(`/${name} `);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      }
    });
  };

  // 仅在创建中、待确认或仍有未完成步骤时显示顶部计划状态槽。
  const { activePlanMessages, conversationMessages } = useMemo(
    () => ({
      activePlanMessages: messages.filter(
        (message) =>
          message.role === 'plan' &&
          (message.planPending ||
            message.planPreview ||
            message.planActive ||
            message.planEntries?.some((entry) => entry.status !== 'completed') === true),
      ),
      conversationMessages: messages,
    }),
    [messages],
  );

  // 提交中的 elicitation 在消息流显示状态，审批坞暂时移除操作以防重复响应。
  // 依赖 messages 数组引用而非长度：markSubmitting 只改字段不改长度，长度作
  // 代理指标会漏掉这次更新；引用在审批等待期间稳定（agent 暂停、无流式更新），
  // 点击响应后 markSubmitting 产生新引用即触发重算。无待批请求时首行短路，
  // 流式更新期间不会做全量扫描。
  const activeElicitationRequest = useMemo(() => {
    if (!elicitationRequest) {
      return null;
    }
    const isSubmitting = messages.some(
      (message) =>
        message.elicitationRequestId === elicitationRequest.requestId &&
        message.elicitationStatus === 'submitting',
    );
    return isSubmitting ? null : elicitationRequest;
  }, [elicitationRequest, messages]);

  // 把消息流按「回合」分组：每个 user 消息开启一个回合，直到下一个 user 消息前都属于该回合。
  // 回合内包含 agent 思考过程（tool / 非最终 agent 输出）和最终 agent 回答。
  const { turnBlocks, standaloneSequence, activeTurnKey } = useMemo(() => {
    const turns: { userMessage: ChatMessage; processBuffer: ChatMessage[] }[] = [];
    const standalone: ChatMessage[] = [];
    let current: { userMessage: ChatMessage; processBuffer: ChatMessage[] } | null = null;
    for (const message of conversationMessages) {
      if (message.role === 'user') {
        if (current) {
          turns.push(current);
        }
        current = { userMessage: message, processBuffer: [] };
      } else if (current) {
        current.processBuffer.push(message);
      } else {
        standalone.push(message);
      }
    }
    if (current) {
      turns.push(current);
    }
    const activeKey =
      canCancel && turns.length > 0 ? `turn-${turns[turns.length - 1].userMessage.id}` : null;
    return { turnBlocks: turns, standaloneSequence: standalone, activeTurnKey: activeKey };
  }, [conversationMessages, canCancel]);

  // 渲染消息流：回合外的独立消息（通常是首个 user 之前的 status）直接渲染；
  // 每个回合渲染 TurnBlock，由它控制思考过程的折叠与最终回答的展示。
  const messageItems = useMemo(() => {
    const items: React.ReactNode[] = [];
    if (standaloneSequence.length > 0) {
      items.push(
        <MessageSequence
          key={`standalone-${standaloneSequence[0].id}`}
          messages={standaloneSequence}
          collapsedToolGroups={collapsedToolGroups}
          onSetToolGroupCollapsed={onSetToolGroupCollapsed}
        />,
      );
    }
    for (const turn of turnBlocks) {
      const key = `turn-${turn.userMessage.id}`;
      items.push(
        <TurnBlock
          key={key}
          userMessage={turn.userMessage}
          processMessages={turn.processBuffer}
          isActive={activeTurnKey === key}
          expanded={!!expandedProcesses[key]}
          onToggle={() => setExpandedProcesses((prev) => ({ ...prev, [key]: !prev[key] }))}
          collapsedToolGroups={collapsedToolGroups}
          onSetToolGroupCollapsed={onSetToolGroupCollapsed}
        />,
      );
    }
    return items;
  }, [
    turnBlocks,
    standaloneSequence,
    activeTurnKey,
    expandedProcesses,
    collapsedToolGroups,
    onSetToolGroupCollapsed,
  ]);

  useLayoutEffect(() => {
    if (!shouldFollowMessagesRef.current) {
      return;
    }
    const frameId = requestAnimationFrame(() => {
      const el = messageListRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [messageItems, pendingSlashCommand]);

  useLayoutEffect(() => {
    if (historyScrollResetToken === 0) {
      return;
    }
    shouldFollowMessagesRef.current = false;
    const frameId = requestAnimationFrame(() => {
      const el = messageListRef.current;
      if (el) {
        el.scrollTop = 0;
        setShowScrollToBottom(el.scrollHeight - el.clientHeight > AUTO_SCROLL_BOTTOM_THRESHOLD);
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [historyScrollResetToken]);

  const handleScrollToBottom = useCallback(() => {
    shouldFollowMessagesRef.current = true;
    setShowScrollToBottom(false);
    const el = messageListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  return (
    <ApprovalRequestContext.Provider value={activeApprovalRequestId}>
      <section className="chat-workspace">
        <MemoizedMessageStream
          activePlanMessages={activePlanMessages}
          conversationMessages={conversationMessages}
          messageItems={messageItems}
          selectedProject={selectedProject}
          pendingSlashCommand={pendingSlashCommand}
          isHistoryLoading={isHistoryLoading}
          messageListRef={messageListRef}
          showScrollToBottom={showScrollToBottom}
          onLocatePlan={handleLocatePlan}
          onMessageListScroll={handleMessageListScroll}
          onScrollToBottom={handleScrollToBottom}
        />
        <ApprovalDock
          permissionRequest={permissionRequest}
          elicitationRequest={activeElicitationRequest}
          questionnaireRequest={questionnaireRequest}
          questionnaireRequests={questionnaireRequests}
          onPermissionRespond={onPermissionRespond}
          onElicitationRespond={onElicitationRespond}
          onSelectQuestionnaire={onSelectQuestionnaire}
          onQuestionnaireRespond={onQuestionnaireRespond}
        />

        <form ref={formRef} className="composer" onSubmit={onSubmit}>
          <div className="composer-input">
            {/* 命令面板：在输入框输入以 "/" 开头的命令名时自动弹出（实时过滤 + 描述），
              选中后把 `/<name> ` 填回输入框，由用户补参数再发送。 */}
            {paletteOpen && (
              <div className="command-palette">
                <div className="command-palette-list">
                  {visibleCommands.length === 0 ? (
                    <p className="command-palette-empty">
                      {availableCommands.length === 0
                        ? '会话未连接，发送消息后将自动加载可用命令'
                        : '无匹配命令'}
                    </p>
                  ) : (
                    visibleCommands.map((command) => (
                      <button
                        key={command.name}
                        type="button"
                        className="command-palette-item"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => insertCommand(command.name)}
                      >
                        <span className="command-palette-name">/{command.name}</span>
                        {command.description && (
                          <span className="command-palette-desc">{command.description}</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
            {/* 输入框顶部工具栏：左侧配置区（模型/模式/推理/审批），右侧操作按钮。 */}
            <div className="composer-config-row">
              <div className="config-group">
                <div className="model-picker-anchor config-segment">
                  <button
                    ref={modelButtonRef}
                    type="button"
                    className="model-picker-trigger segment-select-trigger"
                    aria-haspopup="dialog"
                    aria-expanded={modelPickerOpen}
                    aria-label="模型选择"
                    disabled={modelOptions.length === 0}
                    onClick={() => setModelPickerOpen((open) => !open)}
                  >
                    <span className="segment-select-label">{currentModelName}</span>
                    <svg
                      className="segment-select-chevron"
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      aria-hidden="true"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {modelPickerOpen && (
                    <ModelPickerPopover
                      value={currentModelValue}
                      options={modelOptions}
                      emptyLabel={modelEmptyLabel}
                      triggerRef={modelButtonRef}
                      showDetail={false}
                      onChange={onModelChange}
                      onClose={() => setModelPickerOpen(false)}
                    />
                  )}
                </div>
                <div className="config-segment">
                  <SegmentSelect
                    ariaLabel="Agent 模式"
                    options={modeOptions}
                    value={currentMode}
                    emptyLabel={modeEmptyLabel}
                    onChange={onModeChange}
                  />
                </div>
                <div className="config-segment">
                  <SegmentSelect
                    ariaLabel="推理强度"
                    options={thinkingOptions}
                    value={currentThinking}
                    emptyLabel={thinkingEmptyLabel}
                    onChange={onThinkingChange}
                  />
                </div>
                <div
                  className="config-segment approval-config-segment"
                  title="当前会话的工具审批档位"
                >
                  <SegmentSelect
                    ariaLabel="审批档位"
                    options={APPROVAL_PROFILE_OPTIONS}
                    value={approvalProfile}
                    emptyLabel="自动编辑"
                    disabled={!selectedProject}
                    onChange={(value) => onApprovalProfileChange(value as ApprovalProfile)}
                  />
                </div>
              </div>
              <div className="composer-actions-right">
                {/* 加号入口：替代原先的 hint 文字。
              - 点击按钮切换弹出菜单（添加文件 / 插入 / 命令）
              - 「添加文件」交给 App 打开系统文件选择器（accept 不限，任意文件均可选）
              -「插入 / 命令」把 / 填进输入框，由现有 commandToken 机制自动弹出命令面板
              - 草稿会话（未选项目）下按钮禁用 */}
                <div className="composer-attach-anchor">
                  <button
                    ref={attachButtonRef}
                    type="button"
                    className="composer-icon-button composer-attach-button"
                    aria-label="添加"
                    aria-haspopup="menu"
                    aria-expanded={attachMenuOpen}
                    disabled={!selectedProject}
                    onClick={() => setAttachMenuOpen((open) => !open)}
                  >
                    {/* 回形针图标 */}
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                  </button>
                  {attachMenuOpen && (
                    <div className="attach-menu" role="menu" ref={attachMenuRef}>
                      <button
                        type="button"
                        role="menuitem"
                        className="attach-menu-item"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setAttachMenuOpen(false);
                          onSelectFile();
                        }}
                      >
                        添加文件
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="attach-menu-item"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setAttachMenuOpen(false);
                          handlePromptChange('/');
                          textareaRef.current?.focus();
                        }}
                      >
                        插入 / 命令
                      </button>
                    </div>
                  )}
                </div>
                {/* 发送/停止合并为一个图标按钮：
              - agent 运行中（canCancel）显示「停止」图标，点击触发 onCancel
              - 否则显示「发送」图标，点击提交；输入为空或未选项目时禁用 */}
                <button
                  type={canCancel ? 'button' : 'submit'}
                  className={`composer-icon-button${canCancel ? ' is-stop' : ''}`}
                  disabled={canCancel ? false : !selectedProject || !prompt.trim()}
                  onClick={canCancel ? onCancel : undefined}
                  aria-label={canCancel ? '停止' : '发送'}
                  title={canCancel ? '停止' : '发送'}
                >
                  {canCancel ? (
                    // 停止图标：实心方块
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <rect x="3" y="3" width="10" height="10" rx="2" />
                    </svg>
                  ) : (
                    // 发送图标：纸飞机
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            {/* 待发送附件预览：位于输入卡片内、textarea 上方，每个附件一个 chip + 移除按钮。
              dataURL 保留在 React state 里，发送时随 text 一起走 sendAgentMessage。
              - image：缩略图 + 底部文件名条
              - text：文件名 + 「文本」标签（omp 能让模型读到内容）
              - unsupported：文件名 + 「不支持」橙色警告（omp 会兜底成占位符，模型读不到内容） */}
            {pendingAttachments.length > 0 && (
              <div className="pending-images">
                {pendingAttachments.map((att, index) => (
                  <span
                    className={`image-chip${att.kind === 'unsupported' ? ' is-unsupported' : ''}`}
                    key={`${index}-${att.dataUrl.slice(0, 16)}`}
                    title={
                      att.kind === 'unsupported' ? '该类型 agent 可能无法读取内容' : att.fileName
                    }
                  >
                    {att.kind === 'image' ? (
                      <>
                        <img src={att.dataUrl} alt={att.fileName} />
                        <span className="image-chip-filename">{att.fileName}</span>
                      </>
                    ) : (
                      <span className="image-chip-file">
                        <span className="image-chip-name">{att.fileName}</span>
                        {att.kind === 'unsupported' && (
                          <span className="image-chip-warn">不支持</span>
                        )}
                        {att.kind === 'text' && <span className="image-chip-tag">文本</span>}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={`移除附件 ${att.fileName}`}
                      title="移除附件"
                      onClick={() => onRemovePendingAttachment(index)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => handlePromptChange(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              onPaste={onPaste}
              placeholder="向 oh-my-pi agent 说明你想做什么（输入 / 唤起命令，支持粘贴图片）..."
              disabled={!selectedProject}
            />
          </div>
          {(approvalProfile === 'yolo' || approvalProfileNotice) && (
            <div className="approval-profile-notice" aria-live="polite">
              {approvalProfile === 'yolo' && (
                <span>本会话不再请求操作批准，不会提升系统权限。</span>
              )}
              {approvalProfileNotice && <span>{approvalProfileNotice}</span>}
            </div>
          )}
        </form>
      </section>
    </ApprovalRequestContext.Provider>
  );
}
