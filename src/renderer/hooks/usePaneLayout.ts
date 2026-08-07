/**
 * usePaneLayout — 三栏布局侧栏管理 hook。
 *
 * 管理左侧项目栏和右侧上下文栏的折叠/展开/拖拽宽度：
 * - collapseLeftPane / collapseRightPane         单击折叠按钮切换
 * - expandLeftPane / expandRightPane             悬停触发区域时展开
 * - handleLeftResizeStart / handleRightResizeStart  拖拽手柄调整宽度
 * - 左侧预览面板：计时 300ms 后自动展开（若鼠标仍悬停在触发区域上）
 *
 * 返回 appShellClassName（BEM 类名）和 layoutStyle（CSS 变量内联样式），
 * 供 App.tsx 的 <main> 元素直接使用。
 *
 * ## 持久化
 * - 折叠状态与拖拽宽度通过 `desktop:set-pane-layout` 写入 settings.paneLayout，启动时恢复。
 * - 拖拽过程中不写盘，松手（resizingSide 归零）后统一写入一次。
 *
 * ## 窄窗口自适应
 * - 窗口 resize / 侧栏拖拽结束时评估：对话区宽度低于 CHAT_COLLAPSE_WIDTH 时
 *   按 右栏 → 左栏 顺序自动折叠；窗口变宽后按相反顺序自动恢复（带滞回阈值防抖）。
 * - 仅自动恢复「曾被自动折叠」的栏；用户手动折叠的栏不会被自动展开，
 *   用户在窄窗口手动展开的栏（manualExpand）也不会被立即重新折叠。
 *
 * ## 维护
 * - 决策与清洗逻辑在 ../lib/paneLayout.ts（纯函数，可独立验证）。
 * - 拖拽过程中靠 mouseup 事件在 document 级别监听，组件卸载时清理。
 */
import {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
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
} from '../lib/constants';
import {
  CHAT_RESTORE_WIDTH,
  clampPaneWidth,
  computeAdaptiveCollapse,
  normalizePaneWidth,
  sanitizePaneLayoutSettings,
  type PaneCollapseState,
  type PaneLayoutSettings,
} from '../lib/paneLayout';

export function usePaneLayout() {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [leftPaneWidth, setLeftPaneWidth] = useState(LEFT_PANE_DEFAULT_WIDTH);
  const [rightPaneWidth, setRightPaneWidth] = useState(RIGHT_PANE_DEFAULT_WIDTH);
  const [resizingSide, setResizingSide] = useState<PaneSide | null>(null);
  const [collapsePreviewSide, setCollapsePreviewSide] = useState<PaneSide | null>(null);
  const [leftPreviewMounted, setLeftPreviewMounted] = useState(false);
  const [leftPreviewOpen, setLeftPreviewOpen] = useState(false);

  const resizeStateRef = useRef<{
    side: PaneSide;
    startX: number;
    startWidth: number;
    willCollapse: boolean;
  } | null>(null);
  const leftPreviewOpenTimer = useRef<number | null>(null);
  const leftPreviewCloseTimer = useRef<number | null>(null);
  const leftPreviewUnmountTimer = useRef<number | null>(null);
  // 持久化恢复完成前不写盘，避免用默认值覆盖已保存的布局。
  const hydratedRef = useRef(false);
  // 记录每栏是否被窄窗口自动折叠（true = 窗口变宽时可自动恢复；用户手动折叠的栏不自动恢复）。
  const autoCollapsedRef = useRef<PaneCollapseState>({ left: false, right: false });
  // 用户在窄窗口下手动展开的栏：窗口足够宽之前不再对其自动折叠，尊重用户意图。
  const manualExpandRef = useRef<PaneCollapseState>({ left: false, right: false });

  const clearLeftPreviewTimers = useCallback(() => {
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
  }, []);

  const closeLeftPreview = useCallback(() => {
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
  }, [leftPreviewMounted, clearLeftPreviewTimers]);

  const openLeftPreview = useCallback(() => {
    if (!leftCollapsed) {
      return;
    }
    clearLeftPreviewTimers();
    setLeftPreviewMounted(true);
    leftPreviewOpenTimer.current = window.setTimeout(() => {
      setLeftPreviewOpen(true);
      leftPreviewOpenTimer.current = null;
    }, 0);
  }, [leftCollapsed, clearLeftPreviewTimers]);

  const openLeftPreviewLater = useCallback(() => {
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
  }, [leftCollapsed, leftPreviewOpen, openLeftPreview]);

  const keepLeftPreviewOpen = useCallback(() => {
    if (leftPreviewCloseTimer.current !== null) {
      window.clearTimeout(leftPreviewCloseTimer.current);
      leftPreviewCloseTimer.current = null;
    }
  }, []);

  const closeLeftPreviewLater = useCallback(() => {
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
  }, [closeLeftPreview]);

  const collapseLeftPane = useCallback(() => {
    // 用户手动折叠：清除自适应标记，窗口变宽时不自动恢复。
    autoCollapsedRef.current.left = false;
    manualExpandRef.current.left = false;
    closeLeftPreview();
    setLeftCollapsed(true);
  }, [closeLeftPreview]);

  const expandLeftPane = useCallback(() => {
    // 用户手动展开：清除自动折叠标记；若窗口仍然偏窄，标记为手动展开以避免被立即重新折叠。
    autoCollapsedRef.current.left = false;
    manualExpandRef.current.left = window.innerWidth - leftPaneWidth - rightPaneWidth < CHAT_RESTORE_WIDTH;
    clearLeftPreviewTimers();
    setLeftPreviewOpen(false);
    setLeftPreviewMounted(false);
    setLeftPaneWidth((width) => normalizePaneWidth('left', width));
    setLeftCollapsed(false);
  }, [clearLeftPreviewTimers, leftPaneWidth, rightPaneWidth]);

  const toggleLeftPane = useCallback(() => {
    if (leftCollapsed) {
      expandLeftPane();
      return;
    }
    collapseLeftPane();
  }, [leftCollapsed, expandLeftPane, collapseLeftPane]);

  const collapseRightPane = useCallback(() => {
    // 用户手动折叠：清除自适应标记，窗口变宽时不自动恢复。
    autoCollapsedRef.current.right = false;
    manualExpandRef.current.right = false;
    setRightCollapsed(true);
  }, []);

  const expandRightPane = useCallback(() => {
    // 用户手动展开：清除自动折叠标记；若窗口仍然偏窄，标记为手动展开以避免被立即重新折叠。
    autoCollapsedRef.current.right = false;
    manualExpandRef.current.right = window.innerWidth - leftPaneWidth - rightPaneWidth < CHAT_RESTORE_WIDTH;
    setRightPaneWidth((width) => normalizePaneWidth('right', width));
    setRightCollapsed(false);
  }, [leftPaneWidth, rightPaneWidth]);

  const toggleRightPane = useCallback(() => {
    if (rightCollapsed) {
      expandRightPane();
      return;
    }
    collapseRightPane();
  }, [rightCollapsed, expandRightPane, collapseRightPane]);

  const startPaneResize = useCallback((side: PaneSide, event: ReactMouseEvent<HTMLDivElement>) => {
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
  }, [leftCollapsed, rightCollapsed, leftPaneWidth, rightPaneWidth]);

  // 拖拽过程中的 mousemove/mouseup 监听
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
  }, [resizingSide, collapseLeftPane, collapseRightPane]);

  // leftCollapsed 变为 true 时清理左栏预览状态
  useEffect(() => {
    if (!leftCollapsed) {
      clearLeftPreviewTimers();
      setLeftPreviewOpen(false);
      setLeftPreviewMounted(false);
    }
  }, [leftCollapsed, clearLeftPreviewTimers]);

  // 组件卸载时清理 timer
  useEffect(() => {
    return () => clearLeftPreviewTimers();
  }, [clearLeftPreviewTimers]);

  // 启动时从持久化 settings 恢复侧栏布局；读取失败保持默认布局。
  useEffect(() => {
    let cancelled = false;
    window.ohMyPiDesktop.getState().then((state) => {
      if (cancelled) {
        return;
      }
      const persisted = sanitizePaneLayoutSettings(state.settings?.paneLayout);
      if (persisted) {
        setLeftPaneWidth(persisted.leftWidth);
        setRightPaneWidth(persisted.rightWidth);
        setLeftCollapsed(persisted.leftCollapsed);
        setRightCollapsed(persisted.rightCollapsed);
      }
      hydratedRef.current = true;
    }).catch(() => {
      // 读取失败不阻塞使用，后续操作仍可正常持久化。
      hydratedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 持久化写回：折叠状态或宽度变化时保存；拖拽过程中（resizingSide 非空）不写，松手后统一写一次。
  useEffect(() => {
    if (!hydratedRef.current || resizingSide) {
      return;
    }
    const layout: PaneLayoutSettings = {
      leftWidth: leftPaneWidth,
      rightWidth: rightPaneWidth,
      leftCollapsed,
      rightCollapsed,
    };
    window.ohMyPiDesktop.setPaneLayout(layout).catch(() => {
      // 写盘失败不影响当前布局，下次操作时重试。
    });
  }, [leftCollapsed, rightCollapsed, leftPaneWidth, rightPaneWidth, resizingSide]);

  // 窄窗口自适应评估：空间不足时自动折叠侧栏，空间恢复后自动还原（详见 lib/paneLayout.ts）。
  const evaluateAdaptiveLayout = useCallback(() => {
    const windowWidth = window.innerWidth;
    // 全展开时对话区已足够宽 → 清除手动展开标记，恢复自动折叠能力。
    if (windowWidth - leftPaneWidth - rightPaneWidth >= CHAT_RESTORE_WIDTH) {
      manualExpandRef.current = { left: false, right: false };
    }
    const desired = computeAdaptiveCollapse(
      windowWidth,
      { collapsed: leftCollapsed, width: leftPaneWidth },
      { collapsed: rightCollapsed, width: rightPaneWidth },
      manualExpandRef.current,
    );
    // 只自动折叠当前展开的栏、只自动恢复曾被自动折叠的栏；用户手动操作的状态不动。
    if (desired.right !== rightCollapsed) {
      if (desired.right) {
        autoCollapsedRef.current.right = true;
        setRightCollapsed(true);
      } else if (autoCollapsedRef.current.right) {
        autoCollapsedRef.current.right = false;
        setRightCollapsed(false);
      }
    }
    if (desired.left !== leftCollapsed) {
      if (desired.left) {
        autoCollapsedRef.current.left = true;
        setLeftCollapsed(true);
      } else if (autoCollapsedRef.current.left) {
        autoCollapsedRef.current.left = false;
        setLeftCollapsed(false);
      }
    }
  }, [leftCollapsed, rightCollapsed, leftPaneWidth, rightPaneWidth]);

  // 窗口尺寸变化时评估自适应。
  useEffect(() => {
    window.addEventListener('resize', evaluateAdaptiveLayout);
    return () => window.removeEventListener('resize', evaluateAdaptiveLayout);
  }, [evaluateAdaptiveLayout]);

  // 侧栏拖拽结束（resizingSide 归零）后评估一次：拖宽侧栏可能把对话区压到舒适宽度以下。
  // 该 effect 在挂载时也会执行一次，兼作初始评估；evaluateAdaptiveLayout 幂等，重复执行无副作用。
  useEffect(() => {
    if (!resizingSide) {
      evaluateAdaptiveLayout();
    }
  }, [resizingSide, evaluateAdaptiveLayout]);

  // 派生 className / style
  const layoutClassName = [
    'layout-grid',
    resizingSide ? 'is-resizing' : ''
  ].filter(Boolean).join(' ');
  const appShellClassName = [
    'app-shell',
    leftCollapsed ? 'left-pane-collapsed' : '',
    resizingSide ? 'is-resizing' : ''
  ].filter(Boolean).join(' ');
  const layoutStyle: CSSProperties = {
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

  return {
    leftCollapsed,
    rightCollapsed,
    leftPaneWidth,
    rightPaneWidth,
    resizingSide,
    collapsePreviewSide,
    leftPreviewMounted,
    leftPreviewOpen,
    toggleLeftPane,
    collapseLeftPane,
    expandLeftPane,
    toggleRightPane,
    collapseRightPane,
    expandRightPane,
    startPaneResize,
    closeLeftPreview,
    openLeftPreviewLater,
    keepLeftPreviewOpen,
    closeLeftPreviewLater,
    layoutClassName,
    appShellClassName,
    layoutStyle,
    leftHandleClassName,
    rightHandleClassName,
    leftPreviewClassName,
  };
}
