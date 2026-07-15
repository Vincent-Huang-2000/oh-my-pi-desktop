import { useEffect, useRef } from 'react';

const GIT_BRANCH_SWITCH_ERROR_MESSAGES: Record<GitBranchSwitchFailureReason, string> = {
  'unmerged-files': '当前分支存在尚未解决的文件冲突。请先解决冲突并完成提交，或中止当前合并操作后再切换。',
  'local-changes': '当前修改会被目标分支覆盖。请先提交、暂存到 stash 或放弃这些修改，然后重新切换。',
  'untracked-files': '当前未跟踪文件与目标分支中的文件冲突。请先移动、删除或提交这些文件，然后重新切换。',
  'branch-not-found': '目标分支不存在或已被删除。请刷新分支列表后重新选择。',
  'git-operation-in-progress': '当前仓库正在执行合并、变基或拣选操作。请先完成或中止该操作，然后重新切换分支。',
  unknown: '分支切换失败。请检查当前仓库状态后重试。',
};

/**
 * 兼容开发期主进程尚未重启的旧返回值：原始 Git 文本只用于识别类型，绝不直接展示给用户。
 */
export function resolveGitBranchSwitchFailure(
  reason: GitBranchSwitchFailureReason | null | undefined,
  legacyDiagnostic = ''
): Pick<GitBranchSwitchError, 'reason' | 'message'> {
  let resolvedReason = reason ?? 'unknown';
  if (!reason) {
    const normalized = legacyDiagnostic.toLowerCase();
    if (normalized.includes('resolve your current index first') || normalized.includes('needs merge')) {
      resolvedReason = 'unmerged-files';
    } else if (normalized.includes('local changes to the following files would be overwritten')) {
      resolvedReason = 'local-changes';
    } else if (normalized.includes('untracked working tree files would be overwritten')) {
      resolvedReason = 'untracked-files';
    } else if (
      normalized.includes('cannot switch branch while') ||
      normalized.includes('you are in the middle of') ||
      normalized.includes('merge_head exists')
    ) {
      resolvedReason = 'git-operation-in-progress';
    } else if (normalized.includes('invalid reference') || normalized.includes('did not match any file')) {
      resolvedReason = 'branch-not-found';
    }
  }
  return {
    reason: resolvedReason,
    message: GIT_BRANCH_SWITCH_ERROR_MESSAGES[resolvedReason],
  };
}

export type GitBranchSwitchError = {
  reason: GitBranchSwitchFailureReason;
  message: string;
  currentBranch: string;
  targetBranch: string;
};

type GitBranchSwitchErrorModalProps = {
  error: GitBranchSwitchError;
  onClose: () => void;
};

/** 全局展示分支切换失败，避免错误被折叠的右侧审查栏遮蔽。 */
export function GitBranchSwitchErrorModal({ error, onClose }: GitBranchSwitchErrorModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop git-branch-error-backdrop" role="presentation">
      <section
        className="git-branch-error-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-branch-error-title"
        aria-describedby="git-branch-error-message"
      >
        <div className="git-branch-error-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M12 8v5M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M10.3 4.2 3.2 17a2 2 0 0 0 1.75 3h14.1a2 2 0 0 0 1.75-3L13.7 4.2a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="git-branch-error-content">
          <h2 id="git-branch-error-title">无法切换到“{error.targetBranch}”</h2>
          <p id="git-branch-error-message">{error.message}</p>
          <dl className="git-branch-error-branches">
            <div>
              <dt>当前分支</dt>
              <dd>{error.currentBranch || '未知分支'}</dd>
            </div>
            <div>
              <dt>目标分支</dt>
              <dd>{error.targetBranch}</dd>
            </div>
          </dl>
          <div className="git-branch-error-actions">
            <button ref={closeButtonRef} className="git-branch-error-confirm" type="button" onClick={onClose}>
              留在当前分支
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
