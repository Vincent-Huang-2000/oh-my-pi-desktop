/**
 * agentUtils — 纯工具函数集合。
 *
 * 职责：
 * - JSON-RPC 消息判别（isJsonRpcRequest/Notification/Response）。
 * - 从 ACP 协议载荷中提取结构化字段（text、toolCallId、model 快照等）。
 * - 权限请求文本的归一化呈现（getPermissionMessage）。
 * - config optinos 与 permission options 的归一化与校验。
 * - 通用辅助：isRecord、getLogLevel、stringifySafe。
 *
 * 特点：所有函数为纯函数或仅依赖参数输入，不持有进程状态。
 */
import type { AcpConfigOption, AgentEvent, StoredLog, ToolModelSnapshot } from './types.js';
import type { AcpProcessState, PermissionOption, SessionNotification } from './agentTypes.js';

// ── 基础工具 ──

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

export const getLogLevel = (eventType: AgentEvent['type']): StoredLog['level'] => {
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

// ── JSON‑RPC 判别 ──

export const isJsonRpcRequest = (
  value: unknown,
): value is { jsonrpc: '2.0'; id: string | number | null; method: string; params?: unknown } => {
  return (
    isRecord(value) && value.jsonrpc === '2.0' && 'id' in value && typeof value.method === 'string'
  );
};

export const isJsonRpcNotification = (
  value: unknown,
): value is { jsonrpc: '2.0'; method: string; params?: unknown } => {
  return (
    isRecord(value) &&
    value.jsonrpc === '2.0' &&
    !('id' in value) &&
    typeof value.method === 'string'
  );
};

export const isJsonRpcResponse = (
  value: unknown,
): value is {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
} => {
  return isRecord(value) && value.jsonrpc === '2.0' && 'id' in value && !('method' in value);
};

// ── 内容提取 ──

export const getTextContent = (value: unknown): string => {
  if (!isRecord(value)) {
    return '';
  }
  const text = value.text;
  return typeof text === 'string' ? text : '';
};

// v17.2.9+ agent 在 agent_message_chunk 中推送 image 内容块（{ type:'image', data, mimeType }）。
// 将其转为 data: URL 的 Markdown 图片，交由渲染层的 ReactMarkdown 展示。
export const getImageMarkdown = (value: unknown): string => {
  if (!isRecord(value)) {
    return '';
  }
  const data = value.data;
  const mimeType = value.mimeType;
  if (typeof data !== 'string' || typeof mimeType !== 'string') {
    return '';
  }
  return `![image](data:${mimeType};base64,${data})`;
};

export const stringifySafe = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const getToolCallMessage = (update: Record<string, unknown>) => {
  const title = update.title;
  if (typeof title === 'string' && title.trim()) {
    return title;
  }
  return '';
};

export const getToolCallId = (update: Record<string, unknown>) => {
  return typeof update.toolCallId === 'string' ? update.toolCallId : '';
};

// ── ACP session / model 快照 ──

export const getAcpSessionIdForSnapshot = (
  process: AcpProcessState,
  params: SessionNotification,
) => {
  if (typeof params.sessionId === 'string') {
    return params.sessionId;
  }
  return process.acpSessionId ?? process.restoredAcpSessionId ?? '';
};

export const getCurrentModelSnapshot = (
  configOptions: AcpConfigOption[],
): ToolModelSnapshot | undefined => {
  const modelOpt = configOptions.find((option) => option.id === 'model');
  if (!modelOpt || typeof modelOpt.currentValue !== 'string') {
    return undefined;
  }
  const id = modelOpt.currentValue;
  const name = modelOpt.options?.find((option) => option.value === id)?.name ?? id;
  return { id, name };
};

// ── 审批 / Permission ──

export const getPermissionMessage = (params: unknown) => {
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

export const normalizePermissionOptions = (value: unknown): PermissionOption[] => {
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
        description: typeof item.description === 'string' ? item.description : undefined,
      },
    ];
  });
};

// ── Config ──

export const normalizeConfigOptions = (value: unknown): AcpConfigOption[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.type !== 'string'
    ) {
      return [];
    }

    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
          if (
            !isRecord(option) ||
            typeof option.value !== 'string' ||
            typeof option.name !== 'string'
          ) {
            return [];
          }
          return [
            {
              value: option.value,
              name: option.name,
              description: typeof option.description === 'string' ? option.description : undefined,
            },
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
          typeof item.currentValue === 'string' || typeof item.currentValue === 'boolean'
            ? item.currentValue
            : undefined,
        options,
      },
    ];
  });
};
