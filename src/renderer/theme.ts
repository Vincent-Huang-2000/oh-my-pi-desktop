/**
 * theme — 主题注册表与切换逻辑。
 *
 * ## 架构
 * - 主题通过 CSS `data-theme` 属性作用于 `<html>` 元素，各主题的 CSS 变量覆盖写在 styles.css 中。
 * - `ThemeRegistry` 维护所有已注册主题的元数据（id / 显示名 / 种类），供 UI 构建切换列表与图标。
 * - `registerTheme()` 允许后续注册自定义主题（不同样式的白天/夜间主题），无需修改核心代码。
 * - 默认主题：`light`（浅色），fallback 由 CSS `:root` 块提供。
 *
 * ## 使用
 * - `applyTheme(id)` 写入 `document.documentElement.dataset.theme`，触发 CSS 变量切换。
 * - `listThemes()` 返回全部已注册主题，供 UI 渲染列表。
 * - `toggleTheme(currentId)` 纯函数：仅计算切换后的主题 ID，不读写 DOM。
 *
 * DOM 同步单一入口：App 的 useEffect 监听 themeId state 后调用 `applyTheme`，
 * 新增主题变更路径时只需更新 state，不要在本模块内直写 DOM。
 */

/** 主题种类：浅色或深色，决定切换图标的视觉语义。 */
export type ThemeKind = 'light' | 'dark';

/** 主题定义：注册表中的一条记录。 */
export type ThemeDefinition = {
  /** 主题唯一标识，对应 CSS `[data-theme="<id>"]` 选择器。 */
  id: string;
  /** 中文显示名，用于 UI 列表和 tooltip。 */
  label: string;
  /** 浅色/深色种类，决定图标和默认行为。 */
  kind: ThemeKind;
};

// ── 内置主题 ──────────────────────────────────────────────────

const BUILTIN_THEMES: ThemeDefinition[] = [
  { id: 'light', label: '浅色', kind: 'light' },
  { id: 'dark', label: '深色', kind: 'dark' },
];

// ── 主题注册表 ────────────────────────────────────────────────

const registry = new Map<string, ThemeDefinition>();

// 注册内置主题。
for (const theme of BUILTIN_THEMES) {
  registry.set(theme.id, theme);
}

/**
 * 注册一个自定义主题。若 id 已存在则覆盖（允许应用级定制内置主题的显示名）。
 * 注意：CSS 变量覆盖仍需在 styles.css 或额外样式表中提供对应的 `[data-theme="<id>"]` 块。
 */
export function registerTheme(theme: ThemeDefinition): void {
  registry.set(theme.id, theme);
}

/** 按 id 查找主题定义；未找到返回 undefined。 */
export function getTheme(id: string): ThemeDefinition | undefined {
  return registry.get(id);
}

/** 返回所有已注册主题的列表（内置 + 自定义）。 */
export function listThemes(): ThemeDefinition[] {
  return [...registry.values()];
}

/** 默认主题 ID，启动时未设置 themeId 时使用。 */
export const DEFAULT_THEME_ID = 'light';

// ── DOM 操作 ──────────────────────────────────────────────────

/**
 * 激活指定主题：写入 `<html data-theme="id">`。
 * 传入无效 id 时回退到默认浅色主题。
 */
export function applyTheme(themeId: string): void {
  // 一次性解析为局部变量再写 DOM：保证「校验」与「写入」用的是同一个值，
  // 即使注册表在校验后被并发修改也不会写出不一致的结果。
  const effective = registry.get(themeId)?.id ?? DEFAULT_THEME_ID;
  document.documentElement.setAttribute('data-theme', effective);
}

/**
 * 纯函数：根据当前主题 ID 计算 light ↔ dark 切换后的主题 ID。
 * 不读写 DOM——DOM 同步由 App 的 useEffect 统一负责（见文件顶部说明）。
 * 传入未注册的 id 时按浅色处理，目标是切到深色。
 * 注册表中没有目标种类的主题时，打印告警并返回当前 ID（切换为无操作），
 * 避免静默回退到一个同样可能无效的主题。
 */
export function toggleTheme(currentId: string): string {
  const currentTheme = registry.get(currentId);
  const targetKind: ThemeKind = currentTheme?.kind === 'light' ? 'dark' : 'light';
  // 在同种类主题中取第一个（未来有多套浅色/深色主题时，这里只切换到第一套）。
  const target = [...registry.values()].find((t) => t.kind === targetKind);
  if (!target) {
    console.warn(`[theme] 注册表中没有 ${targetKind} 类主题，主题切换无效`);
    return currentId;
  }
  return target.id;
}
