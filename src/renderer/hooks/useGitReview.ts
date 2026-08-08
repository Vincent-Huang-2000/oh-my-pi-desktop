/**
 * useGitReview — Git diff / branch 刷新与分支切换。
 *
 * - refreshDiff(source, project)：按 source（unstaged/staged）拉取 diff 内容并更新 diffText。
 *   使用递增 refreshId 防竞态，只有最新一次拉取的结果才写入 state。
 * - refreshGitBranches()：拉取当前项目 git 分支列表。
 * - handleGitBranchSwitch(branchName)：切换分支，失败时捕获错误显示专用 Modal。
 *
 * refreshDiff 和 refreshGitBranches 均为 useCallback([], ...)，无外部依赖，
 * 作为参数传给 useAgentEvents 用于回合 done / error 后自动刷新。
 *
 * ## 维护
 * - refreshDiff 内部用 selectedProjectRef.current 防闭包过期。
 * - GitBranchSwitchError 类型定义在 components/GitBranchSwitchErrorModal。
 */
import { useCallback, useEffect } from 'react';
import { resolveGitBranchSwitchFailure } from '../components/GitBranchSwitchErrorModal';
import { REVIEW_SOURCE_LABEL, type ReviewSource } from '../lib/constants';
import { useAppCore } from './useAppCore';

export function useGitReview(app: ReturnType<typeof useAppCore>) {
  const refreshDiff = useCallback(
    async (source: ReviewSource, project = app.selectedProjectRef.current) => {
      const refreshId = app.diffRefreshIdRef.current + 1;
      app.diffRefreshIdRef.current = refreshId;
      const sourceLabel = REVIEW_SOURCE_LABEL[source];

      if (!project) {
        app.setDiffText('');
        app.setDiffStatus('请选择项目后查看 Git 改动');
        return;
      }

      try {
        app.setDiffStatus(`正在读取${sourceLabel}改动...`);
        const result = await window.ohMyPiDesktop.getDiff(project.path, source);

        // 用户快速切换项目/来源时，旧请求可能后返回；这里丢弃旧结果，避免右栏显示错项目 diff。
        if (
          refreshId !== app.diffRefreshIdRef.current ||
          app.selectedProjectRef.current?.path !== project.path ||
          app.reviewSourceRef.current !== source
        ) {
          return;
        }

        app.setDiffText(result.diff);
        if (!result.ok && !result.diff) {
          app.setDiffStatus(result.message || `读取${sourceLabel}改动失败`);
          return;
        }
        app.setDiffStatus(
          result.diff ? `已读取${sourceLabel}改动` : result.message || `当前没有${sourceLabel}改动`,
        );
      } catch (error) {
        if (
          refreshId !== app.diffRefreshIdRef.current ||
          app.selectedProjectRef.current?.path !== project.path ||
          app.reviewSourceRef.current !== source
        ) {
          return;
        }
        app.setDiffText('');
        app.setDiffStatus(error instanceof Error ? error.message : `读取${sourceLabel}改动失败`);
        return;
      }
    },
    [],
  );

  const refreshGitBranches = useCallback(async (project = app.selectedProjectRef.current) => {
    const refreshId = app.branchRefreshIdRef.current + 1;
    app.branchRefreshIdRef.current = refreshId;
    if (!project) {
      app.setGitBranches([]);
      app.setCurrentGitBranch('');
      app.setGitBranchNotice('');
      return null;
    }

    const result = await window.ohMyPiDesktop.getGitBranches(project.path);
    // 请求序号与项目路径共同防止快速切换项目时，旧仓库的异步结果覆盖当前审查状态。
    if (
      refreshId !== app.branchRefreshIdRef.current ||
      app.selectedProjectRef.current?.path !== project.path
    ) {
      return null;
    }
    app.setGitBranches(result.branches);
    app.setCurrentGitBranch(result.currentBranch);
    app.setGitBranchNotice(result.ok ? '' : result.message);
    if (!result.ok) {
      return null;
    }
    return result.currentBranch;
  }, []);

  const syncGitReview = useCallback(
    async (project = app.selectedProjectRef.current) => {
      if (!project) {
        await refreshGitBranches(project);
        return;
      }

      const nextBranch = await refreshGitBranches(project);
      if (nextBranch === null || app.selectedProjectRef.current?.path !== project.path) {
        return;
      }

      // 外部终端既可能切换分支，也可能改变暂存区或工作区；事件触发时需同步当前来源的 diff。
      // 这里仍是 focus/visibility 驱动而非轮询，不会持续创建 Git 子进程。
      await refreshDiff(app.reviewSourceRef.current, project);
    },
    [refreshDiff, refreshGitBranches],
  );

  useEffect(() => {
    app.reviewSourceRef.current = app.reviewSource;
  }, [app.reviewSource]);

  useEffect(() => {
    void refreshDiff(app.reviewSource);
  }, [refreshDiff, app.reviewSource, app.selectedProject?.path, app.selectedSession?.id]);

  useEffect(() => {
    // 切换项目时解除旧项目的分支切换加载态，新项目独立读取自己的分支。
    app.setSwitchingGitBranch(false);
    void refreshGitBranches(app.selectedProject);
  }, [refreshGitBranches, app.selectedProject?.path]);

  const handleRefreshGitReview = async () => {
    // 用户主动刷新时同时同步分支列表、暂存区和工作区改动。
    await syncGitReview();
  };

  const handleReviewSourceChange = (source: ReviewSource) => {
    app.reviewSourceRef.current = source;
    app.setReviewSource(source);
  };

  const handleGitBranchChange = async (branchName: string) => {
    const project = app.selectedProjectRef.current;
    if (!project || !branchName || branchName === app.currentGitBranch || app.switchingGitBranch) {
      return;
    }

    app.setSwitchingGitBranch(true);
    app.setGitBranchSwitchError(null);
    app.setGitBranchNotice(`正在切换到 ${branchName}...`);
    try {
      const result = await window.ohMyPiDesktop.switchGitBranch(project.path, branchName);
      if (app.selectedProjectRef.current?.path !== project.path) {
        return;
      }
      if (!result.ok) {
        // 分支切换失败属于阻断操作，使用全局弹窗确保右栏折叠时用户仍能看到处理建议。
        const failure = resolveGitBranchSwitchFailure(result.reason, result.message);
        app.setGitBranchNotice('');
        app.setGitBranchSwitchError({
          ...failure,
          currentBranch: app.currentGitBranch,
          targetBranch: branchName,
        });
        return;
      }
      app.setGitBranchNotice(`已切换到 ${branchName}`);
      await refreshGitBranches(project);
      await refreshDiff(app.reviewSourceRef.current, project);
    } catch (error) {
      // IPC 异常保留给开发者控制台排查，前端只显示不含内部细节的中文提示。
      console.error('切换 Git 分支请求失败', error);
      const failure = resolveGitBranchSwitchFailure('unknown');
      app.setGitBranchNotice('');
      app.setGitBranchSwitchError({
        ...failure,
        currentBranch: app.currentGitBranch,
        targetBranch: branchName,
      });
    } finally {
      if (app.selectedProjectRef.current?.path === project.path) {
        app.setSwitchingGitBranch(false);
      }
    }
  };

  const closeGitBranchSwitchError = useCallback(() => {
    app.setGitBranchSwitchError(null);
  }, []);

  return {
    refreshDiff,
    refreshGitBranches,
    syncGitReview,
    handleReviewSourceChange,
    handleGitBranchChange,
    handleRefreshGitReview,
    closeGitBranchSwitchError,
  };
}
