import { useEffect, useRef, useState } from 'react';

// 通用 SVG 图标（Feather 风格，统一 14x14 / 16x16 viewBox）
const IconPlus = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const IconMoreHorizontal = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="3" cy="8" r="1.2" fill="currentColor" />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" />
    <circle cx="13" cy="8" r="1.2" fill="currentColor" />
  </svg>
);

const IconX = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const IconStar = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="var(--color-pin)" aria-hidden="true">
    <path d="M8 1.3l1.8 4.3 4.7.4-3.5 3.1 1 4.7L8 11.5l-4 2.5 1-4.7-3.5-3.1 4.7-.4z" />
  </svg>
);

const IconRefreshCw = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

const IconFolder = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

const IconChevronRight = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

type ProjectPaneProps = {
  variant?: 'pane' | 'preview';
  onTogglePane?: () => void;
  onClosePreview?: () => void;
  desktopState: DesktopState;
  // 展示用的项目列表（pinned 已排在最前）。不传时回退到 desktopState.recentProjects 保持兼容。
  projects?: StoredProject[];
  selectedProject: StoredProject | null;
  selectedSession: StoredSession | null;
  sessionsForProject: StoredSession[];
  expandedProjectPaths: string[];
  onSelectWorkspace: () => void;
  onToggleProjectExpanded: (projectPath: string) => void;
  // 顶部操作区：作用于当前执行目录（selectedProject）。
  onNewSession: () => void;
  onNewProjectSession: (project: StoredProject) => void;
  onOpenSessionSearch: () => void;
  onSyncSessions: () => void;
  onSelectProjectSession: (project: StoredProject, session: StoredSession) => void;
  // 项目行 ⋯ 菜单的动作。
  onToggleProjectPinned: (project: StoredProject) => void;
  onRevealProject: (project: StoredProject) => void;
  // session 行 ⋯ 菜单的动作：Fork / 关闭作用于被点击的会话。
  onForkSession: (project: StoredProject, session: StoredSession) => void;
  onCloseSession: (project: StoredProject, session: StoredSession) => void;
  // 重命名项目（仅改显示名）。
  onRenameProject: (project: StoredProject, displayName: string) => void;
  // 移除项目（只删项目本身，会话行保留）。
  onRemoveProject: (project: StoredProject) => void;
};

const formatSessionTime = (value: string) => {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    return '';
  }
  const diffMinutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (diffMinutes < 1) {
    return '刚刚';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} 分`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} 天`;
};


// 会话列表分页：默认只展示最新 5 条，展开每次新增 8 条，折叠回到 5 条。
const INITIAL_SESSION_VISIBLE = 5;
const SESSION_EXPAND_STEP = 8;

type ProjectGroupItemProps = {
  project: StoredProject;
  isSelected: boolean;
  isExpanded: boolean;
  sessions: StoredSession[];
  selectedSession: StoredSession | null;
  onToggleExpanded: (path: string) => void;
  onSelectSession: (project: StoredProject, session: StoredSession) => void;
  onTogglePinned: (project: StoredProject) => void;
  onReveal: (project: StoredProject) => void;
  onNewSession: (project: StoredProject) => void;
  onRename: (project: StoredProject, displayName: string) => void;
  onRemove: (project: StoredProject) => void;
  isMenuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  // session 行 ⋯ 菜单：Fork / 关闭作用于被点击的会话。
  onForkSession: (project: StoredProject, session: StoredSession) => void;
  onCloseSession: (project: StoredProject, session: StoredSession) => void;
  // 当前打开的 session ⋯ 菜单 id（null 表示无）；同一时刻项目菜单与 session 菜单互斥。
  openSessionMenuId: string | null;
  onToggleSessionMenu: (sessionId: string) => void;
  onCloseSessionMenu: () => void;
};

// 项目标题展示用名：优先 displayName，其次 name（目录名）。
const getProjectDisplayName = (project: StoredProject) =>
  (project.displayName && project.displayName.trim()) || project.name;

/* session 列表项：左侧标题 + 相对时间，右侧 ⋯ 菜单（Fork / 关闭 / 打开项目目录）。
   - 点击标题区切换会话；点 ⋯ 按钮 stopPropagation 后开菜单，不切换会话。
   - 菜单交互复用项目行 ⋯ 菜单模式：同时只开一个、外部点击/Esc 关闭由 ProjectPane 统一处理。
   - TODO: 重命名会话——当前不做，因 /resume 同步会用 omp session/list 的 title 覆盖本地 title，
            待 omp 提供改名能力后再加。 */
type SessionItemProps = {
  project: StoredProject;
  session: StoredSession;
  isSelected: boolean;
  isMenuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onSelect: (project: StoredProject, session: StoredSession) => void;
  onFork: (project: StoredProject, session: StoredSession) => void;
  onClose: (project: StoredProject, session: StoredSession) => void;
  onReveal: (project: StoredProject) => void;
};

function SessionItem({
  project,
  session,
  isSelected,
  isMenuOpen,
  onToggleMenu,
  onCloseMenu,
  onSelect,
  onFork,
  onClose,
  onReveal,
}: SessionItemProps) {
  const canFork = Boolean(session.acpSessionId);
  return (
    <div className={isSelected ? 'session-item active' : 'session-item'}>
      <button
        className="session-item-main"
        type="button"
        onClick={() => onSelect(project, session)}
        title={session.title}
      >
        <span className="session-title">{session.title}</span>
        <span className="session-time">{formatSessionTime(session.updatedAt)}</span>
      </button>
      <div className="session-actions">
        <button
          className="project-action-button session-action-button"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleMenu();
          }}
          title="更多会话操作"
          aria-label={`${session.title} 更多会话操作`}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
        >
          <IconMoreHorizontal />
        </button>
        {isMenuOpen && (
          <div className="project-menu session-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="project-menu-item"
              disabled={!canFork}
              title={canFork ? `复制 ${session.title} 为新分支` : '当前会话尚未关联远端，无法 Fork'}
              onClick={() => {
                onCloseMenu();
                onFork(project, session);
              }}
            >
              Fork 会话
            </button>
            <button
              type="button"
              role="menuitem"
              className="project-menu-item"
              onClick={() => {
                onCloseMenu();
                onReveal(project);
              }}
            >
              打开项目目录
            </button>
            <button
              type="button"
              role="menuitem"
              className="project-menu-item project-menu-item-danger"
              onClick={() => {
                onCloseMenu();
                onClose(project, session);
              }}
            >
              关闭会话
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectGroupItem({
  project,
  isSelected,
  isExpanded,
  sessions,
  selectedSession,
  onToggleExpanded,
  onSelectSession,
  onTogglePinned,
  onReveal,
  onNewSession,
  onRename,
  onRemove,
  isMenuOpen,
  onToggleMenu,
  onCloseMenu,
  onForkSession,
  onCloseSession,
  openSessionMenuId,
  onToggleSessionMenu,
  onCloseSessionMenu,
}: ProjectGroupItemProps) {
  // 内联重命名：进入编辑态时把当前展示名填入输入框；提交时回调用方，Esc/失焦取消。
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  // 会话列表分页：当前展示条数。默认展示最新 5 条，展开每次 +8，折叠回到 5 条。
  // sessions 已按最新在前排序（当前活动会话置顶），直接 slice 即可优先展示最新会话。
  const [visibleCount, setVisibleCount] = useState(INITIAL_SESSION_VISIBLE);
  const visibleSessions = sessions.slice(0, visibleCount);
  const hasMoreSessions = sessions.length > visibleCount;
  const canCollapse = visibleCount > INITIAL_SESSION_VISIBLE;

  const startRename = () => {
    setRenameValue(getProjectDisplayName(project));
    setIsRenaming(true);
    onCloseMenu();
  };
  const commitRename = () => {
    const next = renameValue.trim();
    if (next && next !== getProjectDisplayName(project)) {
      onRename(project, next);
    }
    setIsRenaming(false);
  };
  const cancelRename = () => setIsRenaming(false);

  // 进入编辑态后自动聚焦并选中文本，便于直接覆盖原名。
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  return (
    <section className={isExpanded ? 'project-group expanded' : 'project-group'}>
      <div className={isSelected ? 'project-header active' : 'project-header'}>
        {/* 点击目录名仅展开/折叠，不切换执行目录；只有点击 session 才进入执行目录。
            高亮的 session 不因点击目录名而改变。
            重命名态下切换为受控 input，Enter 提交 / Esc 取消 / 失焦提交。 */}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="project-rename-input"
            type="text"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelRename();
              }
            }}
            aria-label={`重命名 ${project.name}`}
          />
        ) : (
          <button
            className={isSelected ? 'project-title active' : 'project-title'}
            type="button"
            onClick={() => onToggleExpanded(project.path)}
            aria-label={isExpanded ? `折叠 ${getProjectDisplayName(project)}` : `展开 ${getProjectDisplayName(project)}`}
          >
            <span className="project-chevron-icon" aria-hidden="true"><IconChevronRight /></span>
            <span className="project-name">{getProjectDisplayName(project)}</span>
            {project.pinned && (
              <span
                className="project-pin-indicator"
                aria-label="已置顶"
                title="已置顶"
              >
                <IconStar />
              </span>
            )}
          </button>
        )}
        <div className="project-actions">
          <button
            className="project-action-button"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleMenu();
            }}
            title="更多项目操作"
            aria-label={`${project.name} 更多项目操作`}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
          >
            <IconMoreHorizontal />
          </button>
          <button
            className="project-action-button"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onNewSession(project);
            }}
            title={`在 ${project.name} 中新建会话`}
            aria-label={`在 ${project.name} 中新建会话`}
          >
            <IconPlus />
          </button>
          {isMenuOpen && (
            <div className="project-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="project-menu-item"
                onClick={() => {
                  onCloseMenu();
                  onTogglePinned(project);
                }}
              >
                {project.pinned ? '取消置顶' : '置顶项目'}
              </button>
              <button
                type="button"
                role="menuitem"
                className="project-menu-item"
                onClick={() => {
                  onCloseMenu();
                  onReveal(project);
                }}
              >
                在资源管理员中打开
              </button>
              <button
                type="button"
                role="menuitem"
                className="project-menu-item"
                onClick={startRename}
              >
                重命名项目
              </button>
              <button
                type="button"
                role="menuitem"
                className="project-menu-item project-menu-item-danger"
                onClick={() => {
                  onCloseMenu();
                  onRemove(project);
                }}
              >
                移除项目
              </button>
            </div>
          )}
        </div>
      </div>
      {isExpanded && (
        <div className="session-list">
          {sessions.length === 0 && <span className="empty-text">暂无对话</span>}
          {visibleSessions.map((session) => (
            <SessionItem
              key={session.id}
              project={project}
              session={session}
              isSelected={selectedSession?.id === session.id}
              isMenuOpen={openSessionMenuId === session.id}
              onToggleMenu={() => onToggleSessionMenu(session.id)}
              onCloseMenu={onCloseSessionMenu}
              onSelect={onSelectSession}
              onFork={onForkSession}
              onClose={onCloseSession}
              onReveal={onReveal}
            />
          ))}
          {/* 分页控制：展开/折叠按钮并行显示。
              - 有更多会话时显示「展开展示」，点击 +8 条。
              - 当前已超出初始数量时显示「折叠显示」，点击回到初始 5 条。
              - 半展开状态下两个按钮同时出现。 */}
          {(hasMoreSessions || canCollapse) && (
            <div className="session-list-pager">
              {hasMoreSessions && (
                <button
                  type="button"
                  className="session-list-pager-button"
                  onClick={() => setVisibleCount((count) => count + SESSION_EXPAND_STEP)}
                >
                  展开展示
                </button>
              )}
              {canCollapse && (
                <button
                  type="button"
                  className="session-list-pager-button"
                  onClick={() => setVisibleCount(INITIAL_SESSION_VISIBLE)}
                >
                  折叠显示
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
export function ProjectPane({
  variant = 'pane',
  onTogglePane,
  onClosePreview,
  desktopState,
  projects,
  selectedProject,
  selectedSession,
  sessionsForProject,
  expandedProjectPaths,
  onSelectWorkspace,
  onToggleProjectExpanded,
  onNewSession,
  onNewProjectSession,
  onOpenSessionSearch,
  onSyncSessions,
  onSelectProjectSession,
  onToggleProjectPinned,
  onRevealProject,
  onRenameProject,
  onRemoveProject,
  onForkSession,
  onCloseSession
}: ProjectPaneProps) {
  // 当前展开 ⋯ 菜单的项目 path；同时只允许一个菜单处于打开状态。
  const [openMenuForPath, setOpenMenuForPath] = useState<string | null>(null);
  // 当前展开 ⋯ 菜单的 session id；与项目菜单互斥（同时只开一个）。
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);
  const projectList = projects ?? desktopState.recentProjects;
  const paneClassName = variant === 'preview' ? 'project-pane project-pane-preview' : 'project-pane';
  // 用 mousedown 关闭外侧菜单：避免在外层 onClick 先吃掉点击之前漏关。
  // 同时响应 Esc 键关闭。任一菜单打开时挂载，关闭后自动卸载。
  const paneRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!openMenuForPath && !openSessionMenuId) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      if (paneRef.current && !paneRef.current.contains(event.target as Node)) {
        setOpenMenuForPath(null);
        setOpenSessionMenuId(null);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenuForPath(null);
        setOpenSessionMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [openMenuForPath, openSessionMenuId]);

  const closeMenu = () => {
    setOpenMenuForPath(null);
    setOpenSessionMenuId(null);
  };
  // 切换项目菜单：开任一菜单前先关掉另一个，保证同时只有一个。
  const toggleProjectMenu = (path: string) => {
    setOpenSessionMenuId(null);
    setOpenMenuForPath((current) => (current === path ? null : path));
  };
  // 切换 session 菜单：同理先关项目菜单。
  const toggleSessionMenu = (sessionId: string) => {
    setOpenMenuForPath(null);
    setOpenSessionMenuId((current) => (current === sessionId ? null : sessionId));
  };

  return (
    <aside
      ref={paneRef}
      className={paneClassName}
    >
      {variant === 'preview' && (
        <button
          className="preview-close-button"
          type="button"
          onClick={onClosePreview}
          aria-label="关闭项目预览侧栏"
          title="关闭"
        >
          <IconX />
        </button>
      )}
      <div className="pane-heading">
        {variant === 'pane' && onTogglePane ? (
          <button
            className="project-pane-toggle-button"
            type="button"
            onClick={onTogglePane}
            aria-label="折叠左侧项目栏"
            title="折叠左侧项目栏"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
              <path d="M11 6L9 8l2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <span className="pane-heading-placeholder" aria-hidden="true" />
        )}
        <div className="pane-heading-actions">
          <button
            className="search-session-icon"
            type="button"
            onClick={onOpenSessionSearch}
            title="搜索会话"
            aria-label="搜索会话"
          >
            {/* 搜索入口仅打开居中窗口，暂不在左栏内做过滤。 */}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.2 10.2L13 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="new-session-icon"
            type="button"
            onClick={onNewSession}
            disabled={!selectedProject}
            title={selectedProject ? `在 ${selectedProject.name} 中新建会话` : '请先选择执行目录'}
            aria-label="新建会话"
          >
            {/* 加号图标：与同步、折叠按钮风格保持一致 */}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="sync-sessions"
            type="button"
            onClick={onSyncSessions}
            disabled={!selectedProject}
            title={selectedProject ? `同步 ${selectedProject.name} 的历史会话` : '请先选择执行目录'}
            aria-label="同步历史会话"
          >
            <IconRefreshCw />
          </button>
          {/* 打开目录按钮已上提到 TopBar 身份区；左栏此处仅保留新建与同步入口，
              避免与"添加项目目录"等 ＋ 入口撞符号、也与顶部操作区职责区分。 */}
        </div>
      </div>
      <div className="project-list">
        {projectList.length === 0 ? (
          // 空状态引导：列表无项目时展示一张占位卡片，引导用户选择目录。
          // 这是"打开目录"在左栏的主要落点（紧贴它影响的列表）。
          <button
            type="button"
            className="empty-projects-card"
            onClick={onSelectWorkspace}
            title="选择一个本地目录作为项目"
          >
            <span className="empty-projects-icon" aria-hidden="true"><IconFolder /></span>
            <span className="empty-projects-title">还没有项目</span>
            <span className="empty-projects-hint">点击选择项目目录</span>
          </button>
        ) : (
          <>
            {projectList.map((project) => {
              const isSelected = selectedProject?.path === project.path;
              const isExpanded = expandedProjectPaths.includes(project.path);
              const projectSessions = isSelected
                ? sessionsForProject
                : desktopState.recentSessions.filter((session) => session.projectPath === project.path);

              return (
                <ProjectGroupItem
                  key={project.path}
                  project={project}
                  isSelected={isSelected}
                  isExpanded={isExpanded}
                  sessions={projectSessions}
                  selectedSession={selectedSession}
                  onToggleExpanded={onToggleProjectExpanded}
                  onSelectSession={onSelectProjectSession}
                  onTogglePinned={onToggleProjectPinned}
                  onReveal={onRevealProject}
                  onRename={onRenameProject}
                  onRemove={onRemoveProject}
                  onNewSession={onNewProjectSession}
                  isMenuOpen={openMenuForPath === project.path}
                  onToggleMenu={() => toggleProjectMenu(project.path)}
                  onCloseMenu={closeMenu}
                  onForkSession={onForkSession}
                  onCloseSession={onCloseSession}
                  openSessionMenuId={openSessionMenuId}
                  onToggleSessionMenu={toggleSessionMenu}
                  onCloseSessionMenu={closeMenu}
                />
              );
            })}
            {/* 列表末尾追加弱化的"添加项目目录"条目：与上方项目用样式区分，
                避免和真实项目条目混淆。 */}
            <button
              type="button"
              className="add-project-card"
              onClick={onSelectWorkspace}
              title="打开 / 添加项目目录"
            >
              <IconPlus /> 添加项目目录
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
