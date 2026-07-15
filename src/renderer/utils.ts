import type { AcpConfigOption, ChatMessage, ElicitationField, ElicitationRequest, PlanEntry, QuestionnaireQuestion, ToolCallDiffBlock, ToolCallLocation } from './types';

export const formatTime = (value?: string) => {
  if (!value) {
    return '--';
  }
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
};

export const getPayloadRequestId = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const record = payload as Record<string, unknown>;
  return String(record.requestId ?? record.id ?? '');
};

export const getPayloadMessageId = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const record = payload as Record<string, unknown>;
  const update = record.update;
  if (!update || typeof update !== 'object') {
    return '';
  }
  const messageId = (update as Record<string, unknown>).messageId;
  return typeof messageId === 'string' ? messageId : '';
};

export const getPayloadConfigOptions = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const record = payload as Record<string, unknown>;
  return Array.isArray(record.configOptions) ? record.configOptions : [];
};

export const getPayloadPermissionOptions = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.options)) {
    return [];
  }

  return record.options.filter((option) => {
    if (!option || typeof option !== 'object') {
      return false;
    }
    const item = option as Record<string, unknown>;
    return typeof item.optionId === 'string' && typeof item.name === 'string' && typeof item.kind === 'string';
  }).map((option) => {
    const item = option as Record<string, unknown>;
    return {
      optionId: String(item.optionId),
      name: String(item.name),
      kind: String(item.kind),
      description: typeof item.description === 'string' ? item.description : undefined
    };
  });
};

// 从 elicitation_request 事件 payload 提取表单字段信息。
// omp 的 elicitation 总是单字段 value，schema 结构为
// { requestedSchema: { properties: { value: { type, enum?, oneOf?, description? } } } }。
export const getPayloadElicitationField = (payload: unknown): ElicitationField => {
  const fallback: ElicitationField = { type: 'string' };
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  const schema = record.requestedSchema;
  if (!schema || typeof schema !== 'object') {
    return fallback;
  }
  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== 'object') {
    return fallback;
  }
  const valueProp = (properties as Record<string, unknown>).value;
  if (!valueProp || typeof valueProp !== 'object') {
    return fallback;
  }
  const field = valueProp as Record<string, unknown>;
  const type = typeof field.type === 'string' ? field.type : 'string';
  // enum（无标题选项）或 oneOf（带标题选项）都映射为 options 列表。
  const options: string[] = [];
  if (Array.isArray(field.enum)) {
    field.enum.forEach((item) => {
      if (typeof item === 'string') {
        options.push(item);
      }
    });
  } else if (Array.isArray(field.oneOf)) {
    field.oneOf.forEach((item) => {
      if (item && typeof item === 'object') {
        const constValue = (item as Record<string, unknown>).const;
        if (typeof constValue === 'string') {
          options.push(constValue);
        }
      }
    });
  }
  const description =
    typeof field.description === 'string' ? field.description : undefined;
  return {
    type: type as ElicitationField['type'],
    options: options.length > 0 ? options : undefined,
    description
  };
};

// AskTool 与工具/计划审批共用 elicitation/create；审批消息由 omp 使用固定前缀生成，
// 其余表单请求按 agent 提问展示。这里只影响界面语义，不改变回传给 ACP 的原始值。
export const getElicitationKind = (message: string): ElicitationRequest['kind'] => {
  return /^Allow tool:/m.test(message) || /^Approve plan "/m.test(message)
    ? 'approval'
    : 'question';
};

// AskTool 的运行时控制项在桌面端显示为中文，但点击后仍提交原始英文值。
export const formatElicitationOptionLabel = (option: string) => {
  const recommended = option.endsWith(' (Recommended)');
  const raw = recommended ? option.slice(0, -' (Recommended)'.length) : option;
  if (raw.endsWith(' Done selecting')) return '完成选择';
  const labels: Record<string, string> = {
    'Other (type your own)': '其他（输入自定义回答）',
    'Chat about this': '与 agent 讨论这个问题',
    'Done selecting': '完成选择',
    'Next →': '下一题 →',
    // plan 模式审批三选项（omp ACP enum 原始英文值 → 中文按钮）
    'Approve and execute': '批准并执行',
    'Refine plan': '继续修改方案',
    'Reject': '拒绝'
  };
  const label = labels[raw] ?? raw;
  return recommended ? `${label}（推荐）` : label;
};

export const isElicitationOtherOption = (option: string) => option === 'Other (type your own)';

// 主进程已完成严格的 Python 静态解析；渲染端只做防御性归一化，避免异常事件撑坏弹窗。
export const getPayloadQuestionnaire = (payload: unknown): QuestionnaireQuestion[] => {
  if (!payload || typeof payload !== 'object') return [];
  const questionnaire = (payload as Record<string, unknown>).questionnaire;
  if (!questionnaire || typeof questionnaire !== 'object') return [];
  const questions = (questionnaire as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const question = item as Record<string, unknown>;
    if (typeof question.question !== 'string' || typeof question.multiSelect !== 'boolean' || !Array.isArray(question.options)) {
      return [];
    }
    const options = question.options.flatMap((option) => {
      if (!option || typeof option !== 'object') return [];
      const value = option as Record<string, unknown>;
      return typeof value.label === 'string'
        ? [{ label: value.label, ...(typeof value.description === 'string' ? { description: value.description } : {}) }]
        : [];
    });
    return options.length > 0
      ? [{
          question: question.question,
          ...(typeof question.header === 'string' ? { header: question.header } : {}),
          options,
          multiSelect: question.multiSelect
        }]
      : [];
  });
};

// 部分 agent 会先通过 elicitation 发送「审批问题 + 完整 Markdown 方案」，
// 用户确认后才下发结构化 plan。提前拆出方案，让审批期间也能完整阅读。
export const splitElicitationPlan = (message: string) => {
  const heading = /(?:^|\r?\n)(#{1,6}\s+\S.*)$/m.exec(message);
  if (!heading || heading.index < 0) {
    return { question: message.trim(), plan: '' };
  }
  const headingOffset = heading[0].search(/#{1,6}\s+/);
  const planStart = heading.index + Math.max(headingOffset, 0);
  return {
    question: message.slice(0, planStart).trim(),
    plan: message.slice(planStart).trim()
  };
};

export const getPayloadFullPlan = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';
  const fullPlan = (payload as Record<string, unknown>).fullPlan;
  return typeof fullPlan === 'string' ? fullPlan.trim() : '';
};

// 从 `commands_update` 事件 payload 提取可用命令列表（ACP availableCommands）。
export const getPayloadAvailableCommands = (payload: unknown): AcpAvailableCommand[] => {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.commands)) {
    return [];
  }
  return record.commands
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const obj = item as Record<string, unknown>;
      if (typeof obj.name !== 'string') {
        return null;
      }
      return {
        name: obj.name,
        description: typeof obj.description === 'string' ? obj.description : ''
      } satisfies AcpAvailableCommand;
    })
    .filter((command): command is AcpAvailableCommand => command !== null);
};

export const getMessageRole = (eventType: AgentEvent['type']): ChatMessage['role'] => {
  if (eventType === 'user_message') {
    return 'user';
  }
  if (eventType === 'thought') {
    return 'thought';
  }
  if (eventType === 'tool_call') {
    return 'tool';
  }
  if (eventType === 'error') {
    return 'error';
  }
  if (eventType === 'done' || eventType === 'status_update' || eventType === 'usage_update') {
    return 'status';
  }
  if (eventType === 'plan') {
    return 'plan';
  }
  return 'agent';
};

export const getLogLevel = (eventType: AgentEvent['type']): StoredLog['level'] => {
  if (eventType === 'tool_call') {
    return 'tool';
  }
  if (eventType === 'diff') {
    return 'diff';
  }
  if (eventType === 'done') {
    return 'done';
  }
  if (eventType === 'error') {
    return 'error';
  }
  return 'info';
};

/* 从 AgentEvent payload 中提取 ACP ToolCall 结构化数据。
   payload 结构为 { update: { sessionUpdate, toolCallId, kind, title, status, locations, content } } */
export const getPayloadToolCall = (payload: unknown) => {
  const def: {
    toolCallId: string;
    title: string;
    kind: string | undefined;
    status: string | undefined;
    locations: ToolCallLocation[] | undefined;
    diffs: ToolCallDiffBlock[] | undefined;
    output: string | undefined;
    toolModel: { id: string; name: string } | undefined;
  } = {
    toolCallId: '',
    title: '',
    kind: undefined,
    status: undefined,
    locations: undefined,
    diffs: undefined,
    output: undefined,
    toolModel: undefined
  };
  if (!payload || typeof payload !== 'object') return def;
  const record = payload as Record<string, unknown>;
  const toolModel = record.toolModel;
  if (toolModel && typeof toolModel === 'object') {
    const model = toolModel as Record<string, unknown>;
    if (typeof model.id === 'string' && typeof model.name === 'string') {
      def.toolModel = { id: model.id, name: model.name };
    }
  }
  const update = record.update;
  if (!update || typeof update !== 'object') return def;
  const u = update as Record<string, unknown>;
  def.toolCallId = typeof u.toolCallId === 'string' ? u.toolCallId : '';
  def.title = typeof u.title === 'string' ? u.title : '';
  def.kind = typeof u.kind === 'string' ? u.kind : undefined;
  def.status = typeof u.status === 'string' ? u.status : undefined;
  if (Array.isArray(u.locations)) {
    def.locations = u.locations.filter(
      (loc): loc is Record<string, unknown> =>
        typeof loc === 'object' && loc !== null && typeof (loc as Record<string, unknown>).path === 'string'
    ).map((loc) => {
      const l = loc as Record<string, unknown>;
      const line = l.line;
      return { path: String(l.path), line: typeof line === 'number' || line === null ? line : undefined };
    });
  }
  if (Array.isArray(u.content)) {
    def.diffs = u.content.filter(
      (item): item is Record<string, unknown> => typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'diff'
    ).map((item) => ({
      type: 'diff' as const,
      path: typeof item.path === 'string' ? item.path : undefined,
      oldText: typeof item.oldText === 'string' ? item.oldText : undefined,
      newText: typeof item.newText === 'string' ? item.newText : undefined
    }));
    // 提取非 diff 的流式文本块（ACP { type:'content', content:{ type:'text', text } }），
    // 命令输出 / 读取结果等中间产物拼接成可见文本。
    const texts = u.content
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'content')
      .map((item) => {
        const inner = item.content;
        return inner && typeof inner === 'object' && typeof (inner as Record<string, unknown>).text === 'string'
          ? String((inner as Record<string, unknown>).text)
          : '';
      })
      .filter((text) => text.length > 0);
    if (texts.length > 0) def.output = texts.join('\n');
  }
  return def;
};

const normalizePlanEntries = (entries: unknown): PlanEntry[] => {
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).content === 'string'
  ).map((entry) => {
    const rawPriority = typeof entry.priority === 'string' ? entry.priority : '';
    const rawStatus = typeof entry.status === 'string' ? entry.status : '';
    return {
      content: String(entry.content),
      priority: (rawPriority === 'high' || rawPriority === 'medium' || rawPriority === 'low') ? rawPriority : 'medium',
      status: (rawStatus === 'pending' || rawStatus === 'in_progress' || rawStatus === 'completed') ? rawStatus : 'pending',
    };
  });
};

export type PayloadPlanChange =
  | {
      action: 'replace';
      planId?: string;
      contentType: 'items' | 'markdown' | 'file';
      entries: PlanEntry[];
      text?: string;
    }
  | { action: 'remove'; planId: string };

/* 归一化旧版整表 plan 与按 ID 更新的 plan_update / plan_removed。 */
export const getPayloadPlanChange = (payload: unknown): PayloadPlanChange | null => {
  if (!payload || typeof payload !== 'object') return null;
  const update = (payload as Record<string, unknown>).update;
  if (!update || typeof update !== 'object') return null;
  const record = update as Record<string, unknown>;
  if (record.sessionUpdate === 'plan') {
    return { action: 'replace', contentType: 'items', entries: normalizePlanEntries(record.entries) };
  }
  if (record.sessionUpdate === 'plan_removed') {
    return typeof record.id === 'string' ? { action: 'remove', planId: record.id } : null;
  }
  if (record.sessionUpdate !== 'plan_update' || !record.plan || typeof record.plan !== 'object') {
    return null;
  }
  const plan = record.plan as Record<string, unknown>;
  if (typeof plan.id !== 'string') return null;
  if (plan.type === 'items') {
    return {
      action: 'replace',
      planId: plan.id,
      contentType: 'items',
      entries: normalizePlanEntries(plan.entries),
    };
  }
  if (plan.type === 'markdown' && typeof plan.content === 'string') {
    return {
      action: 'replace',
      planId: plan.id,
      contentType: 'markdown',
      entries: [],
      text: plan.content,
    };
  }
  if (plan.type === 'file' && typeof plan.uri === 'string') {
    return {
      action: 'replace',
      planId: plan.id,
      contentType: 'file',
      entries: [],
      text: plan.uri,
    };
  }
  return null;
};


// 从 AcpConfigOption 单个 option 中提取可选的 provider 字段。
// omp 尚未在 option 上声明 provider 字段前先留口,识别到任意 provider 字符串都返回。
const readProvider = (option: { description?: string } | undefined): string | null => {
  if (!option) return null;
  // omp 后续若在 description 里以 "provider: Anthropic" 形式声明,这里即可识别。
  const match = option.description?.match(/^\s*provider\s*[:：]\s*(\S+)/i);
  return match ? match[1].trim() : null;
};

// 从模型 name 推断 provider,优先子串匹配已知厂商;无法识别时归到"自定义 API"。
// 子串匹配比前缀匹配更宽容,能覆盖 "deepseek-chat"、"qwen-turbo" 等常见命名。
export const inferModelProvider = (name: string): string => {
  const lower = name.toLowerCase();
  if (lower.includes('claude')) return 'Anthropic';
  if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) {
    return 'OpenAI';
  }
  if (lower.includes('gemini') || lower.includes('gemma')) return 'Google';
  if (lower.includes('qwen')) return 'Qwen';
  if (lower.includes('llama')) return 'Meta';
  if (lower.includes('deepseek')) return 'DeepSeek';
  if (lower.includes('mistral')) return 'Mistral';
  if (lower.includes('kimi') || lower.includes('moonshot')) return 'Moonshot';
  if (lower.includes('abab') || lower.includes('minimax')) return 'MiniMax';
  if (lower.includes('glm') || lower.includes('chatglm')) return 'Zhipu';
  return '自定义 API';
};

// 按 provider 对模型分组,组内保持原顺序。provider 优先取 option 自带的,
// 缺失时回退到 inferModelProvider(name)。
export type GroupedModelOptions = Array<{ provider: string; models: NonNullable<AcpConfigOption['options']> }>;

export const groupModelOptions = (options: NonNullable<AcpConfigOption['options']>): GroupedModelOptions => {
  const groups = new Map<string, NonNullable<AcpConfigOption['options']>>();
  for (const option of options) {
    const provider = readProvider(option as { description?: string }) ?? inferModelProvider(option.name);
    const list = groups.get(provider) ?? [];
    list.push(option);
    groups.set(provider, list);
  }
  return Array.from(groups, ([provider, models]) => ({ provider, models }));
};

// 简单的子串模糊匹配,大小写不敏感,支持中文。
export const fuzzyMatch = (text: string, query: string): boolean => {
  if (!query) return true;
  return text.toLowerCase().includes(query.toLowerCase());
};
