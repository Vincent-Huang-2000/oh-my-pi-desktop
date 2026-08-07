/**
 * slashCommands — Slash 命令解析与占位卡片类型。
 *
 * - PendingSlashCommand：发送后、omp 回包前展示的过渡卡片类型
 * - parseSlashCommand(text)：从输入文本解析出命令名和参数，返回 null 表示非命令
 * - resolveCommandPendingMeta(name)：查表获取命令的图标和说明文案
 *
 * ## 维护
 * - 新增命令需同时更新 getPayloadAvailableCommands 能从 agent 返回的事件中取到的命令列表。
 * - PendingSlashCommand 按 sessionId 分桶，与 messageCache 生命周期一致。
 */
// 待执行的 slash 命令卡片：用户按下发送后、omp 真正回包前展示，
// 给"按下发送"与"看到输出"之间一个明确的视觉过渡。
// 按 sessionId 分桶，与 messageCache / permissionBySession / usageBySession 同属多 session 隔离缓存。
export type PendingSlashCommand = {
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

// 解析 `/name args` 形式的输入，返回 { name, args }；非 slash 输入返回 null。
// 解析失败的空字符串命令不视为有效命令，避免把普通消息里的 "/" 当成命令。
export const parseSlashCommand = (
  text: string
): { name: string; args: string } | null => {
  const match = text.match(/^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
};

// 根据命令名查 COMMAND_PENDING_META，没命中回退到默认值。
export const resolveCommandPendingMeta = (name: string): { icon: string; label: string } => {
  return COMMAND_PENDING_META[name] ?? COMMAND_PENDING_DEFAULT;
};
