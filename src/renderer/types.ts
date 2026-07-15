/* ACP ToolKind 映射：用于图标着色和分类展示 */
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

/* ACP ToolCallStatus：工具调用生命周期 */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/* ACP ToolCallLocation：工具影响的文件位置 */
export type ToolCallLocation = {
  path: string;
  line?: number | null;
};

/* ACP ToolCallContent 中的 diff 块 */
export type ToolCallDiffBlock = {
  type: 'diff';
  path?: string;
  oldText?: string;
  newText?: string;
};

/* ACP PlanEntry：计划步骤 */
export type PlanEntry = {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'agent' | 'thought' | 'tool' | 'error' | 'status' | 'plan' | 'elicitation';
  text: string;
  /* 工具调用结构化数据（role: 'tool' 时填充） */
  toolCallId?: string;
  toolKind?: ToolKind;
  toolStatus?: ToolCallStatus;
  toolLocations?: ToolCallLocation[];
  /* 工具调用 diff 块（role: 'tool' 时可能含 diff 内容） */
  toolDiffs?: ToolCallDiffBlock[];
  /* 工具调用流式文本输出（ACP content 块，如命令输出/读取结果） */
  toolOutput?: string;
  /* 工具调用发起时的模型快照；历史会话 replay 会优先从本地持久化快照还原 */
  toolModel?: { id: string; name: string };
  /* 计划结构化数据（role: 'plan' 时填充） */
  planId?: string;
  planContentType?: 'items' | 'markdown' | 'file';
  planEntries?: PlanEntry[];
  /* Plan 模式已发送但 ACP 尚未返回计划时，先展示占位提示 */
  planPending?: boolean;
  /* elicitation 已携带完整 Markdown 方案、但正式 plan 事件尚未到达时的预览 */
  planPreview?: boolean;
  /* 关联异步补发的完整方案，避免并发审批时更新到其它预览卡。 */
  planPreviewRequestId?: string;
  /* 未能从磁盘读到完整方案，仅展示 message 片段时标记，用于在卡片上提示内容可能不完整。 */
  planPreviewDegraded?: boolean;
  /* 从 ACP session `_meta` 恢复的当前活跃方案；仅用于展示，不关联历史审批请求。 */
  planActive?: boolean;
  planFilePath?: string;
  /* elicitation 内联记录：按请求 id 原地更新用户的确认结果。 */
  elicitationRequestId?: string;
  elicitationStatus?: 'pending' | 'submitting' | 'accepted' | 'declined' | 'cancelled' | 'failed';
  elicitationResult?: string;
  elicitationKind?: 'questionnaire' | 'question';
  createdAt?: string;
};

export type PermissionRequest = {
  requestId: string;
  message: string;
  options: PermissionOption[];
};

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: string;
  description?: string;
};

/* ACP elicitation 请求：omp 第2层审批门控通过表单向用户请求输入/确认。 */
export type ElicitationRequest = {
  requestId: string;
  message: string;
  field: ElicitationField;
  /* 工具/计划审批与 AskTool 提问共用 ACP elicitation，通过消息格式区分展示语义。 */
  kind: 'approval' | 'question';
  /* plan 审批且消息流已存在对应预览卡时为 true：弹窗只显示简短提示，方案全文交给卡片。 */
  hasPlanPreview?: boolean;
};

/* 表单字段描述：omp 当前只发单字段 value，这里按其 type 归一化。 */
export type ElicitationField = {
  /* 字段类型：string（含 enum 为下拉选择）/ boolean（确认）/ number / integer / array */
  type: 'string' | 'boolean' | 'number' | 'integer' | 'array';
  /* string + enum 时的可选值列表（omp 工具审批场景为 ['Approve', 'Deny']）。 */
  options?: string[];
  /* 字段标题/描述（ACP schema 的 description）。 */
  description?: string;
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

export type QuestionnaireRequest = {
  requestId: string;
  questions: QuestionnaireQuestion[];
};

export type QuestionnaireAnswer = {
  questionIndex: number;
  selections: string[];
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
