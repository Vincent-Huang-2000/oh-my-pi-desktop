/**
 * paneLayout — 侧栏布局的纯函数策略模块。
 *
 * 从 usePaneLayout 抽出的无副作用逻辑，便于独立验证：
 * - clampPaneWidth / normalizePaneWidth   宽度钳制与回正
 * - computeAdaptiveCollapse               窄窗口自适应折叠决策
 * - sanitizePaneLayoutSettings            持久化数据的清洗（读取时防御非法值）
 *
 * ## 维护
 * - 本模块不得引入 React 或 DOM 依赖，保持可在任意 JS 环境运行。
 * - 阈值常量调整需同步更新 docs/UI/ui-layout-reference.md §8。
 */
import {
  LEFT_PANE_COLLAPSE_THRESHOLD,
  LEFT_PANE_DEFAULT_WIDTH,
  LEFT_PANE_MAX_WIDTH,
  LEFT_PANE_MIN_WIDTH,
  RIGHT_PANE_COLLAPSE_THRESHOLD,
  RIGHT_PANE_DEFAULT_WIDTH,
  RIGHT_PANE_MAX_WIDTH,
  RIGHT_PANE_MIN_WIDTH,
  type PaneSide,
} from './constants';

// 对话区舒适宽度下限：低于该值时按 右栏 → 左栏 顺序自动折叠侧栏。
export const CHAT_COLLAPSE_WIDTH = 480;
// 对话区恢复宽度：自动折叠的侧栏在恢复后对话区仍能达到该宽度时才恢复（与折叠阈值形成滞回，避免边界抖动）。
export const CHAT_RESTORE_WIDTH = 520;

export type PaneSnapshot = {
  collapsed: boolean;
  width: number;
};

export type PaneCollapseState = {
  left: boolean;
  right: boolean;
};

// 持久化到 settings.paneLayout 的数据结构（与 electron/types.ts 的 PaneLayoutSettings 保持一致）。
export type PaneLayoutSettings = {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
};

export const clampPaneWidth = (value: number, min: number, max: number) => {
  return Math.min(max, Math.max(min, value));
};

// 拖拽低于折叠阈值后重新展开时回到默认宽度，否则钳制在合法区间。
export const normalizePaneWidth = (side: PaneSide, width: number) => {
  if (side === 'left') {
    return width < LEFT_PANE_COLLAPSE_THRESHOLD
      ? LEFT_PANE_DEFAULT_WIDTH
      : clampPaneWidth(width, LEFT_PANE_MIN_WIDTH, LEFT_PANE_MAX_WIDTH);
  }
  return width < RIGHT_PANE_COLLAPSE_THRESHOLD
    ? RIGHT_PANE_DEFAULT_WIDTH
    : clampPaneWidth(width, RIGHT_PANE_MIN_WIDTH, RIGHT_PANE_MAX_WIDTH);
};

// 读取持久化数据时清洗：宽度钳制到合法区间，非法值整体回退 null（使用默认布局）。
export const sanitizePaneLayoutSettings = (raw: unknown): PaneLayoutSettings | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as Partial<Record<keyof PaneLayoutSettings, unknown>>;
  const { leftWidth, rightWidth, leftCollapsed, rightCollapsed } = candidate;
  if (
    typeof leftWidth !== 'number' ||
    !Number.isFinite(leftWidth) ||
    typeof rightWidth !== 'number' ||
    !Number.isFinite(rightWidth) ||
    typeof leftCollapsed !== 'boolean' ||
    typeof rightCollapsed !== 'boolean'
  ) {
    return null;
  }
  return {
    leftWidth: clampPaneWidth(leftWidth, LEFT_PANE_MIN_WIDTH, LEFT_PANE_MAX_WIDTH),
    rightWidth: clampPaneWidth(rightWidth, RIGHT_PANE_MIN_WIDTH, RIGHT_PANE_MAX_WIDTH),
    leftCollapsed,
    rightCollapsed,
  };
};

/**
 * 窄窗口自适应决策：根据窗口宽度计算两侧栏「期望的」折叠状态。
 *
 * 规则：
 * - 对话区宽度（窗口宽 - 展开的侧栏宽）低于 CHAT_COLLAPSE_WIDTH 时，先折叠右栏，仍不足再折叠左栏。
 * - 窗口变宽时先恢复左栏再恢复右栏；恢复某栏后对话区仍能达到 CHAT_RESTORE_WIDTH 才恢复（滞回防抖）。
 * - manualExpand 标记的栏（用户在窄窗口下手动展开）跳过自动折叠，尊重用户意图。
 *
 * 返回值是「期望状态」，调用方负责只把恢复动作应用到「曾被自动折叠」的栏上，
 * 用户手动折叠的栏不会被自动展开。
 */
export const computeAdaptiveCollapse = (
  windowWidth: number,
  left: PaneSnapshot,
  right: PaneSnapshot,
  manualExpand: PaneCollapseState,
): PaneCollapseState => {
  const desired: PaneCollapseState = { left: left.collapsed, right: right.collapsed };
  // 当前对话区宽度。
  let chatWidth =
    windowWidth - (left.collapsed ? 0 : left.width) - (right.collapsed ? 0 : right.width);

  if (chatWidth < CHAT_COLLAPSE_WIDTH) {
    // 空间不足：先折叠右栏（辅助面板），再折叠左栏。
    if (!desired.right && !manualExpand.right) {
      desired.right = true;
      chatWidth += right.width;
    }
    if (chatWidth < CHAT_COLLAPSE_WIDTH && !desired.left && !manualExpand.left) {
      desired.left = true;
      chatWidth += left.width;
    }
    return desired;
  }

  // 空间充足：按 左栏 → 右栏 顺序尝试恢复；恢复后对话区仍需达到恢复阈值。
  if (desired.left && chatWidth - left.width >= CHAT_RESTORE_WIDTH) {
    desired.left = false;
    chatWidth -= left.width;
  }
  if (desired.right && chatWidth - right.width >= CHAT_RESTORE_WIDTH) {
    desired.right = false;
  }
  return desired;
};
