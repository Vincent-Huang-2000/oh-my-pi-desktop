type TopBarProps = {
  projectName?: string;
  // 当前选中会话的标题；为空（无会话）时不显示。
  sessionTitle?: string;
  ompStatus: string;
  // 用户指定的 omp 可执行文件路径；空字符串表示使用 PATH 中的 'omp'。
  ompPath: string;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onToggleLeftPane: () => void;
  onToggleRightPane: () => void;
  onSelectOmpPath: () => void;
  // 打开/添加项目目录（系统目录选择器 → upsert project）。上提到顶栏身份区后，
  // 左栏折叠时也能访问，避免出现"折叠后无法加入项目"的死角。
  onSelectWorkspace: () => void;
};

// 顶栏全局控件：身份区 + 运行时区。
// 模型 / Agent 模式 / 推理强度 / 审批档位已下放到中间对话工作区的输入框
// （紧贴发送按钮左侧，详见 ChatWorkspace 与 docs/UI/ui-layout-reference.md §5）。
export function TopBar({
  projectName,
  sessionTitle,
  ompStatus,
  ompPath,
  leftCollapsed,
  rightCollapsed,
  onToggleLeftPane,
  onToggleRightPane,
  onSelectOmpPath,
  onSelectWorkspace
}: TopBarProps) {
  // 顶栏布局分为两个视觉层级（详见 docs/UI/ui-layout-reference.md §3）：
  //   1) 身份区（topbar-identity）：品牌 + 当前项目名，轻量展示。
  //   2) 运行时区（runtime-group）：侧栏显隐 + omp 连接状态（带状态点）+ 齿轮设置，
  //      作为环境状态指示而非主要操作。
  const ompBroken = ompStatus.includes('未安装') || ompStatus.includes('未检测');

  return (
    <header className="topbar">
      {/* 1. 身份区：会话标题 + 当前项目名 */}
      <div className="topbar-identity">
        {sessionTitle && (
          <span className="topbar-session-title" title={sessionTitle}>{sessionTitle}</span>
        )}
        <span className="topbar-project-name" title={projectName}>{projectName ?? '未选择项目'}</span>
        {/* 打开/添加项目目录：紧贴项目名，作为"切换项目工作目录"的语义入口。
            用文件夹图标而非 ＋，避免与各处"新建"动作撞符号。 */}
        <button
          type="button"
          className="topbar-open-workspace-button"
          onClick={onSelectWorkspace}
          aria-label="打开项目目录"
          title="打开 / 添加项目目录"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </button>
      </div>

      {/* 2. 运行时区：侧栏显隐 + omp 连接状态 + 设置 */}
      <div className="runtime-group">
        <div className="pane-toggle-group" aria-label="侧栏显示控制">
          <button
            type="button"
            className={leftCollapsed ? 'pane-toggle-button' : 'pane-toggle-button active'}
            aria-label={leftCollapsed ? '展开左侧项目栏' : '折叠左侧项目栏'}
            aria-pressed={!leftCollapsed}
            title={leftCollapsed ? '展开左侧项目栏' : '折叠左侧项目栏'}
            onClick={onToggleLeftPane}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1.5" y="2" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
              {leftCollapsed ? (
                <path d="M5.5 3v10" stroke="currentColor" strokeWidth="1.4" />
              ) : (
                <>
                  <rect x="1.5" y="2" width="5" height="12" rx="1.5" fill="currentColor" opacity=".12" />
                  <path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.4" />
                </>
              )}
            </svg>
          </button>
          <button
            type="button"
            className={rightCollapsed ? 'pane-toggle-button' : 'pane-toggle-button active'}
            aria-label={rightCollapsed ? '展开右侧上下文栏' : '折叠右侧上下文栏'}
            aria-pressed={!rightCollapsed}
            title={rightCollapsed ? '展开右侧上下文栏' : '折叠右侧上下文栏'}
            onClick={onToggleRightPane}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1.5" y="2" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
              {rightCollapsed ? (
                <path d="M10.5 3v10" stroke="currentColor" strokeWidth="1.4" />
              ) : (
                <>
                  <rect x="9.5" y="2" width="5" height="12" rx="1.5" fill="currentColor" opacity=".12" />
                  <path d="M9.5 3v10" stroke="currentColor" strokeWidth="1.4" />
                </>
              )}
            </svg>
          </button>
        </div>
        <span
          className={ompBroken ? 'status-pill danger' : 'status-pill'}
          title={ompBroken ? '未检测到可用的 omp' : 'omp 已连接'}
        >
          <span className={ompBroken ? 'status-dot danger' : 'status-dot'} aria-hidden="true" />
          {ompStatus}
        </span>
        <button
          type="button"
          className="omp-path-setting-button"
          title={ompPath ? `当前 omp: ${ompPath}\n点击切换` : '使用 PATH 中的 omp\n点击切换'}
          aria-label="选择 omp 可执行文件"
          onClick={onSelectOmpPath}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
