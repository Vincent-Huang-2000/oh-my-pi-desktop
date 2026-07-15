import { useEffect, useRef, useState } from 'react';
import { ReviewDiffView } from './ReviewDiffView';

type ReviewSource = 'unstaged' | 'staged';
type ContextTab = 'review' | 'terminal';

type ContextPaneProps = {
  selectedProject: StoredProject | null;
  diffText: string;
  diffStatus: string;
  gitBranches: string[];
  currentGitBranch: string;
  gitBranchNotice: string;
  switchingGitBranch: boolean;
  reviewSource: ReviewSource;
  onGitBranchChange: (branchName: string) => void;
  onReviewSourceChange: (source: ReviewSource) => void;
  onSyncGitReview: () => void | Promise<void>;
  onRefreshReview: () => void;
};

const REVIEW_SOURCE_OPTIONS: { value: ReviewSource; label: string }[] = [
  { value: 'unstaged', label: '未暂存' },
  { value: 'staged', label: '已暂存' },
];

export function ContextPane({
  selectedProject,
  diffText,
  diffStatus,
  gitBranches,
  currentGitBranch,
  gitBranchNotice,
  switchingGitBranch,
  reviewSource,
  onGitBranchChange,
  onReviewSourceChange,
  onSyncGitReview,
  onRefreshReview,
}: ContextPaneProps) {
  const [activeTab, setActiveTab] = useState<ContextTab>('review');
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const sourceMenuRef = useRef<HTMLDivElement>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);
  const currentSource = REVIEW_SOURCE_OPTIONS.find((option) => option.value === reviewSource);
  const hasDiff = diffText.trim().length > 0;

  useEffect(() => {
    const handleWindowClick = (event: MouseEvent) => {
      if (!sourceMenuRef.current?.contains(event.target as Node)) {
        setSourceMenuOpen(false);
      }
      if (!branchMenuRef.current?.contains(event.target as Node)) {
        setBranchMenuOpen(false);
      }
    };
    window.addEventListener('click', handleWindowClick);
    return () => window.removeEventListener('click', handleWindowClick);
  }, []);

  useEffect(() => {
    if (activeTab !== 'review') {
      return;
    }

    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleSync = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      clearTimeout(syncTimer);
      // 恢复窗口时 focus 与 visibilitychange 可能连续触发，短暂去抖可避免重复启动 Git 子进程。
      syncTimer = setTimeout(onSyncGitReview, 80);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        scheduleSync();
      }
    };

    // 仅在审查 Tab 可见时监听外部 Git 变化；右栏折叠会卸载组件，因此不会产生后台同步开销。
    window.addEventListener('focus', scheduleSync);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    scheduleSync();
    return () => {
      clearTimeout(syncTimer);
      window.removeEventListener('focus', scheduleSync);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeTab, onSyncGitReview]);

  const handleSelectSource = (source: ReviewSource) => {
    setSourceMenuOpen(false);
    if (source !== reviewSource) {
      onReviewSourceChange(source);
    }
  };

  const handleSelectBranch = (branchName: string) => {
    setBranchMenuOpen(false);
    if (branchName !== currentGitBranch) {
      onGitBranchChange(branchName);
    }
  };

  return (
    <aside className="context-pane">
      <div className="context-tabbar" role="tablist" aria-label="右侧栏标签">
        <button
          type="button"
          className={activeTab === 'review' ? 'context-tab active' : 'context-tab'}
          role="tab"
          aria-selected={activeTab === 'review'}
          onClick={() => setActiveTab('review')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M8 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5A1.5 1.5 0 0 1 6.5 3.5H8Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M14.5 3.5V8h4.5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M8.5 12h7M8.5 16h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          审查
        </button>
        <button
          type="button"
          className={activeTab === 'terminal' ? 'context-tab active' : 'context-tab'}
          role="tab"
          aria-selected={activeTab === 'terminal'}
          onClick={() => setActiveTab('terminal')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <path d="m7.5 10 2.4 2-2.4 2M12.5 15h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          终端
        </button>
      </div>

      {activeTab === 'review' ? (
        <section className="context-panel context-panel-review" role="tabpanel">
          <div className="review-toolbar">
            <div className="review-branch" ref={branchMenuRef}>
              <button
                type="button"
                className="review-branch-button"
                disabled={!selectedProject || gitBranches.length === 0 || switchingGitBranch}
                aria-haspopup="menu"
                aria-expanded={branchMenuOpen}
                title={currentGitBranch || '当前没有可切换的本地分支'}
                onClick={(event) => {
                  event.stopPropagation();
                  setSourceMenuOpen(false);
                  setBranchMenuOpen((open) => !open);
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="6" cy="5" r="2" stroke="currentColor" strokeWidth="1.6" />
                  <circle cx="18" cy="6" r="2" stroke="currentColor" strokeWidth="1.6" />
                  <circle cx="6" cy="19" r="2" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M6 7v10M8 15c5 0 8-2.5 8-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span>{switchingGitBranch ? '切换中...' : currentGitBranch || '无本地分支'}</span>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {branchMenuOpen && (
                <div className="review-branch-menu" role="menu">
                  {gitBranches.map((branchName) => (
                    <button
                      type="button"
                      className={branchName === currentGitBranch ? 'review-source-option active' : 'review-source-option'}
                      key={branchName}
                      role="menuitemradio"
                      aria-checked={branchName === currentGitBranch}
                      onClick={() => handleSelectBranch(branchName)}
                    >
                      <span>{branchName}</span>
                      {branchName === currentGitBranch && (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="review-toolbar-actions">
              <div className="review-source" ref={sourceMenuRef}>
              <button
                type="button"
                className="review-source-button"
                aria-haspopup="menu"
                aria-expanded={sourceMenuOpen}
                onClick={(event) => {
                  event.stopPropagation();
                  setBranchMenuOpen(false);
                  setSourceMenuOpen((open) => !open);
                }}
              >
                {currentSource?.label ?? '未暂存'}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {sourceMenuOpen && (
                <div className="review-source-menu" role="menu">
                  {REVIEW_SOURCE_OPTIONS.map((option) => (
                    <button
                      type="button"
                      className={option.value === reviewSource ? 'review-source-option active' : 'review-source-option'}
                      key={option.value}
                      role="menuitemradio"
                      aria-checked={option.value === reviewSource}
                      onClick={() => handleSelectSource(option.value)}
                    >
                      {option.label}
                      {option.value === reviewSource && (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className="review-refresh-button"
              disabled={!selectedProject}
              onClick={onRefreshReview}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              刷新
            </button>
            </div>
          </div>
          {gitBranchNotice && <p className="review-branch-notice">{gitBranchNotice}</p>}

          {hasDiff ? (
            <ReviewDiffView diffText={diffText} diffStatus={diffStatus} />
          ) : (
            <div className="context-empty">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M8 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5A1.5 1.5 0 0 1 6.5 3.5H8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M14.5 3.5V8h4.5M8.5 12h7M8.5 16h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <strong>{selectedProject ? '当前来源下没有可展示的改动' : '请先选择 workspace'}</strong>
              <span>{selectedProject ? diffStatus : '选择项目后可以查看 Git 改动。'}</span>
            </div>
          )}
        </section>
      ) : (
        <section className="context-panel" role="tabpanel">
          <div className="context-empty">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <path d="m7.5 10 2.4 2-2.4 2M12.5 15h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <strong>当前没有正在运行的终端会话</strong>
            <span>暂无终端输出。</span>
          </div>
        </section>
      )}
    </aside>
  );
}
