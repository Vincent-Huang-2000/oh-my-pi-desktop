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

const clampPaneWidth = (value: number, min: number, max: number) => {
  return Math.min(max, Math.max(min, value));
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
    closeLeftPreview();
    setLeftCollapsed(true);
  }, [closeLeftPreview]);

  const expandLeftPane = useCallback(() => {
    clearLeftPreviewTimers();
    setLeftPreviewOpen(false);
    setLeftPreviewMounted(false);
    setLeftPaneWidth((width) => normalizePaneWidth('left', width));
    setLeftCollapsed(false);
  }, [clearLeftPreviewTimers]);

  const toggleLeftPane = useCallback(() => {
    if (leftCollapsed) {
      expandLeftPane();
      return;
    }
    collapseLeftPane();
  }, [leftCollapsed, expandLeftPane, collapseLeftPane]);

  const collapseRightPane = useCallback(() => {
    setRightCollapsed(true);
  }, []);

  const expandRightPane = useCallback(() => {
    setRightPaneWidth((width) => normalizePaneWidth('right', width));
    setRightCollapsed(false);
  }, []);

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
