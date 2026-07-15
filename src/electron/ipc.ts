import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { dialog, ipcMain, shell } from 'electron';
import { runCommand } from './command.js';
import {
  ensureDefaultWorkspace,
  getSetting,
  normalizeApprovalProfile,
  readState,
  reconcileProjectSessions,
  removeProject,
  setProjectDisplayName,
  setProjectPinned,
  setSetting,
  touchProjectLastOpened,
  upsertProject,
  upsertSession
} from './state.js';
import type { AgentPromptContent, AgentService } from './agentService.js';
import type { ApprovalProfile } from './types.js';

const MAX_INLINE_UNTRACKED_FILE_SIZE = 512 * 1024;

type GitBranchSwitchFailureReason =
  | 'unmerged-files'
  | 'local-changes'
  | 'untracked-files'
  | 'branch-not-found'
  | 'git-operation-in-progress'
  | 'unknown';

/** 将 Git 原始英文诊断转换成稳定的错误类型和面向用户的中文处理建议。 */
const classifyGitBranchSwitchFailure = (diagnostic: string): {
  reason: GitBranchSwitchFailureReason;
  message: string;
} => {
  const normalized = diagnostic.toLowerCase();
  if (normalized.includes('resolve your current index first') || normalized.includes('needs merge')) {
    return {
      reason: 'unmerged-files',
      message: '当前分支存在尚未解决的文件冲突。请先解决冲突并完成提交，或中止当前合并操作后再切换。'
    };
  }
  if (normalized.includes('local changes to the following files would be overwritten')) {
    return {
      reason: 'local-changes',
      message: '当前修改会被目标分支覆盖。请先提交、暂存到 stash 或放弃这些修改，然后重新切换。'
    };
  }
  if (normalized.includes('untracked working tree files would be overwritten')) {
    return {
      reason: 'untracked-files',
      message: '当前未跟踪文件与目标分支中的文件冲突。请先移动、删除或提交这些文件，然后重新切换。'
    };
  }
  if (
    normalized.includes('cannot switch branch while') ||
    normalized.includes('you are in the middle of') ||
    normalized.includes('merge_head exists')
  ) {
    return {
      reason: 'git-operation-in-progress',
      message: '当前仓库正在执行合并、变基或拣选操作。请先完成或中止该操作，然后重新切换分支。'
    };
  }
  if (normalized.includes('invalid reference') || normalized.includes('did not match any file')) {
    return {
      reason: 'branch-not-found',
      message: '目标分支不存在或已被删除。请刷新分支列表后重新选择。'
    };
  }
  return {
    reason: 'unknown',
    message: '分支切换失败。请检查当前仓库状态后重试。'
  };
};

/** 将 Windows 路径分隔符统一成 git diff 使用的正斜杠格式。 */
const normalizeDiffPath = (filePath: string) => filePath.replace(/\\/g, '/');

/** 校验待读取文件仍在 workspace 内，避免未跟踪文件路径越界。 */
const isInsideWorkspace = (workspacePath: string, filePath: string) => {
  const workspaceRoot = path.resolve(workspacePath);
  const resolvedFilePath = path.resolve(filePath);
  return resolvedFilePath === workspaceRoot || resolvedFilePath.startsWith(`${workspaceRoot}${path.sep}`);
};

/** 按 git diff 需要的行粒度拆分文本，并去掉文件末尾换行带来的空行。 */
const splitTextLines = (text: string) => {
  if (!text) {
    return [];
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
};

/** 为未跟踪文件生成标准 unified diff，让右侧审查面板也能展示新文件内容。 */
const createUntrackedFileDiff = async (workspacePath: string, relativePath: string) => {
  const absolutePath = path.resolve(workspacePath, relativePath);
  if (!isInsideWorkspace(workspacePath, absolutePath)) {
    return '';
  }

  const content = await readFile(absolutePath);
  const diffPath = normalizeDiffPath(relativePath);
  const header = [
    `diff --git a/${diffPath} b/${diffPath}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${diffPath}`,
  ];

  // 未跟踪的大文件或二进制文件只展示文件级提示，避免右侧栏被大量不可读内容撑爆。
  if (content.length > MAX_INLINE_UNTRACKED_FILE_SIZE || content.includes(0)) {
    return [...header, `Binary files /dev/null and b/${diffPath} differ`].join('\n');
  }

  const lines = splitTextLines(content.toString('utf8'));
  if (lines.length === 0) {
    return header.join('\n');
  }

  return [
    ...header,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
};

/** 收集当前 workspace 下所有未跟踪文件，并拼接成可被 diff 解析器消费的文本。 */
const getUntrackedFilesDiff = async (workspacePath: string) => {
  const result = await runCommand('git', ['ls-files', '--others', '--exclude-standard', '-z'], workspacePath);
  if (!result.ok) {
    return { ok: false, diff: '', message: (result.stderr || '').trim() };
  }

  const files = result.stdout.split('\0').filter(Boolean);
  const chunks: string[] = [];
  for (const file of files) {
    try {
      const diff = await createUntrackedFileDiff(workspacePath, file);
      if (diff) {
        chunks.push(diff);
      }
    } catch {
      // 单个未跟踪文件读取失败时跳过，避免影响其他文件的 diff 展示。
    }
  }

  return { ok: true, diff: chunks.join('\n'), message: '' };
};

export const registerDesktopIpcHandlers = (agentService: AgentService) => {
  ipcMain.handle('desktop:get-state', () => readState());
  // 首次启动兜底：在用户文档目录下创建 omp-desktop 文件夹并 upsert 为项目，返回该项目。
  ipcMain.handle('desktop:ensure-default-workspace', () => ensureDefaultWorkspace());
  // 仅更新 lastOpenedAt，不重排项目顺序；用于点击 session 进入执行目录时记录最近操作时间。
  ipcMain.handle('desktop:touch-project-last-opened', (_event, workspacePath: string) =>
    touchProjectLastOpened(workspacePath)
  );
  // 切换项目置顶标记。pinned=true 时渲染层把它固定到项目列表顶部。
  ipcMain.handle('desktop:set-project-pinned', (_event, workspacePath: string, pinned: boolean) =>
    setProjectPinned(workspacePath, pinned)
  );
  // 设置项目自定义显示名；空字符串/与目录名相同则清除，回退到目录名。
  ipcMain.handle('desktop:set-project-display-name', (_event, workspacePath: string, displayName: string) =>
    setProjectDisplayName(workspacePath, displayName)
  );
  // 从 recentProjects 移除项目（只删项目本身，会话行/磁盘 omp 会话不动）。
  // 若该项目的 agent 子进程在跑，由渲染层另行 stopSessionProcess 清理。
  ipcMain.handle('desktop:remove-project', (_event, workspacePath: string) =>
    removeProject(workspacePath)
  );
  // 在系统资源管理器中打开项目目录：对目录路径调用 shell.openPath，三大平台都
  // 会以默认应用（即资源管理器/Finder/文件管理器）打开该目录，比 showItemInFolder
  // 在 Windows 上会落到父目录的行为更符合预期。
  ipcMain.handle('desktop:reveal-in-explorer', async (_event, workspacePath: string) => {
    const error = await shell.openPath(workspacePath);
    return { ok: error === '', message: error };
  });

  ipcMain.handle('desktop:select-workspace', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择项目目录',
      properties: ['openDirectory']
    });

    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    return upsertProject(result.filePaths[0]);
  });

  ipcMain.handle('desktop:use-workspace', (_event, workspacePath: string) => {
    return upsertProject(workspacePath);
  });

  ipcMain.handle('desktop:check-omp', async (_event, workspacePath?: string) => {
    const ompExecutable = getSetting('ompExecutablePath') || 'omp';
    const versionResult = await runCommand(ompExecutable, ['--version'], workspacePath);
    if (versionResult.ok) {
      return {
        installed: true,
        status: 'ready',
        message: (versionResult.stdout || versionResult.stderr).trim() || 'omp 已安装'
      };
    }

    const acpResult = await runCommand(ompExecutable, ['acp', '--help'], workspacePath);
    return {
      installed: acpResult.ok,
      status: acpResult.ok ? 'ready' : 'missing',
      message: (acpResult.stdout || acpResult.stderr || versionResult.stderr || '未检测到 omp').trim()
    };
  });

  // 读取当前用户指定的 omp 可执行文件路径（空字符串表示使用 PATH 中的 'omp'）。
  ipcMain.handle('desktop:get-omp-path', () => {
    return getSetting('ompExecutablePath') || '';
  });

  // 打开文件选择对话框让用户选择 omp 可执行文件，保存设置并执行 --version 验证。
  ipcMain.handle('desktop:select-omp-path', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 omp 可执行文件',
      properties: ['openFile'],
      buttonLabel: '选择'
    });

    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, path: getSetting('ompExecutablePath') || '', message: '用户取消选择' };
    }

    const selectedPath = result.filePaths[0];
    const versionResult = await runCommand(selectedPath, ['--version'], undefined, 6000);
    if (!versionResult.ok) {
      const acpResult = await runCommand(selectedPath, ['acp', '--help'], undefined, 6000);
      if (!acpResult.ok) {
        return {
          ok: false,
          path: getSetting('ompExecutablePath') || '',
          message: (versionResult.stderr || acpResult.stderr || '该文件无法作为 omp 执行').trim()
        };
      }
    }

    setSetting('ompExecutablePath', selectedPath);
    // 切换 omp 路径后，所有已运行的 agent 子进程必须立即终止，避免新旧版本混用。
    agentService.stopAll();
    return {
      ok: true,
      path: selectedPath,
      message: (versionResult.stdout || versionResult.stderr || 'omp 已设置').trim()
    };
  });

  ipcMain.handle(
    'desktop:create-session',
    (_event, projectPath: string, title: string, approvalProfile: ApprovalProfile) => {
      const sessionId = `session-${Date.now()}`;
      return upsertSession(
        projectPath,
        sessionId,
        title || '新的 agent 会话',
        undefined,
        undefined,
        false,
        normalizeApprovalProfile(approvalProfile)
      );
    }
  );

  ipcMain.handle('desktop:start-agent', (_event, sessionId: string, workspacePath: string) => {
    const session = readState().recentSessions.find((item) => item.id === sessionId);
    return agentService.startAgent(
      sessionId,
      workspacePath,
      normalizeApprovalProfile(session?.approvalProfile)
    );
  });

  // 发送消息接受富内容：text 必填，images 可选（dataURL 数组）。
  ipcMain.handle(
    'desktop:send-agent-message',
    (_event, sessionId: string, workspacePath: string, content: AgentPromptContent) => {
      return agentService.sendAgentMessage(sessionId, workspacePath, content);
    }
  );

  ipcMain.handle('desktop:get-agent-config', (_event, sessionId: string, workspacePath: string) => {
    return agentService.getSessionConfig(sessionId, workspacePath);
  });

  ipcMain.handle(
    'desktop:set-agent-config-option',
    (_event, sessionId: string, workspacePath: string, configId: string, value: string | boolean) => {
      return agentService.setSessionConfigOption(sessionId, workspacePath, configId, value);
    }
  );

  ipcMain.handle(
    'desktop:update-session-approval-profile',
    (_event, sessionId: string, workspacePath: string, approvalProfile: ApprovalProfile) => {
      return agentService.updateApprovalProfile(
        sessionId,
        workspacePath,
        normalizeApprovalProfile(approvalProfile)
      );
    }
  );

  ipcMain.handle('desktop:cancel-agent-turn', (_event, sessionId: string) => {
    return agentService.cancelTurn(sessionId);
  });

  ipcMain.handle('desktop:permission-response', (_event, requestId: string, allow: boolean) => {
    return agentService.respondPermission(requestId, allow);
  });

  ipcMain.handle('desktop:permission-option-response', (_event, requestId: string, optionId: string) => {
    return agentService.respondPermissionOption(requestId, optionId);
  });

  // ACP elicitation/create 响应：用户提交表单（accept + content）/ 拒绝 / 取消。
  ipcMain.handle(
    'desktop:elicitation-response',
    (
      _event,
      requestId: string,
      action: 'accept' | 'decline' | 'cancel',
      content?: Record<string, unknown>
    ) => {
      return agentService.respondElicitation(requestId, action, content);
    }
  );

  // Plan 模式兼容问卷：提交选项会隐式批准原 eval，拒绝则回传 Deny。
  ipcMain.handle(
    'desktop:questionnaire-response',
    (
      _event,
      requestId: string,
      action: 'submit' | 'deny',
      answers?: Array<{ questionIndex: number; selections: string[] }>
    ) => agentService.respondQuestionnaire(requestId, action, answers)
  );

  // ACP 会话生命周期
  // 以 omp 的 session/list 为准重建该 workspace 的本地会话列表：分页拉全 + 去重 + 清理幽灵。
  // 用完即杀临时 __list__ 子进程，避免每次同步累积常驻进程。
  ipcMain.handle('desktop:sync-sessions', async (_event, workspacePath: string, keepLocalId?: string) => {
    const remote: { sessionId: string; cwd: string; title?: string; updatedAt?: string }[] = [];
    let cursor: string | undefined;
    let firstError: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await agentService.listSessions(workspacePath, cursor);
      if (!result.ok) {
        firstError = result.message;
        break;
      }
      if (result.sessions) {
        remote.push(...result.sessions);
      }
      cursor = result.nextCursor;
      if (!cursor) {
        break;
      }
    }
    agentService.stopSessionProcess(`__list__${workspacePath}`);
    if (remote.length === 0 && firstError) {
      return { ok: false, message: firstError, state: readState() };
    }
    const state = reconcileProjectSessions(workspacePath, remote, keepLocalId);
    return { ok: true, state };
  });

  ipcMain.handle(
    'desktop:load-session',
    (_event, localSessionId: string, workspacePath: string, acpSessionId: string) => {
      return agentService.loadSession(localSessionId, workspacePath, acpSessionId);
    }
  );

  ipcMain.handle(
    'desktop:resume-session',
    (_event, localSessionId: string, workspacePath: string, acpSessionId: string) => {
      return agentService.resumeSession(localSessionId, workspacePath, acpSessionId);
    }
  );

  ipcMain.handle(
    'desktop:refresh-session-config',
    (_event, localSessionId: string, workspacePath: string, acpSessionId: string) => {
      return agentService.refreshSessionConfig(localSessionId, workspacePath, acpSessionId);
    }
  );

  ipcMain.handle(
    'desktop:fork-session',
    (_event, localSessionId: string, workspacePath: string, sourceAcpSessionId: string) => {
      return agentService.forkSession(localSessionId, workspacePath, sourceAcpSessionId);
    }
  );

  ipcMain.handle('desktop:close-session', (_event, localSessionId: string) => {
    return agentService.closeSession(localSessionId);
  });

  ipcMain.handle('desktop:stop-session-process', (_event, localSessionId: string) => {
    agentService.stopSessionProcess(localSessionId);
    return { ok: true };
  });

  ipcMain.handle('desktop:get-git-branches', async (_event, workspacePath: string) => {
    // 当前仅读取本地分支；后续支持远程分支时，可在这里扩展 refs/remotes 并补充分支来源字段。
    const result = await runCommand(
      'git',
      ['for-each-ref', '--format=%(refname:short)\t%(HEAD)', 'refs/heads'],
      workspacePath
    );
    if (!result.ok) {
      return { ok: false, branches: [], currentBranch: '', message: result.stderr.trim() || '读取 Git 分支失败' };
    }

    const entries = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name, head = ''] = line.split('\t');
      return { name, current: head.trim() === '*' };
    });
    return {
      ok: true,
      branches: entries.map((entry) => entry.name),
      currentBranch: entries.find((entry) => entry.current)?.name ?? '',
      message: ''
    };
  });

  ipcMain.handle('desktop:switch-git-branch', async (_event, workspacePath: string, branchName: string) => {
    const result = await runCommand('git', ['switch', branchName], workspacePath);
    if (!result.ok) {
      const diagnostic = (result.stderr || result.stdout).trim();
      const failure = classifyGitBranchSwitchFailure(diagnostic);
      // 原始 Git 输出只保留在主进程日志中用于排查，不直接暴露给前端用户。
      console.error('[git] switch branch failed', {
        workspacePath,
        branchName,
        reason: failure.reason,
        diagnostic
      });
      return { ok: false, ...failure };
    }
    return {
      ok: true,
      reason: null,
      message: ''
    };
  });

  ipcMain.handle('desktop:get-diff', async (_event, workspacePath: string, source?: 'unstaged' | 'staged') => {
    const repositoryCheck = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], workspacePath);
    if (!repositoryCheck.ok || repositoryCheck.stdout.trim() !== 'true') {
      return {
        ok: false,
        diff: '',
        message: '当前项目尚未初始化 Git 仓库'
      };
    }

    // 让审查面板拿到更接近 VS Code 的可读 diff：中文路径不转义，并识别重命名。
    const args = source === 'staged'
      ? ['-c', 'core.quotepath=false', 'diff', '--cached', '--no-color', '--find-renames']
      : ['-c', 'core.quotepath=false', 'diff', '--no-color', '--find-renames'];
    const result = await runCommand('git', args, workspacePath);
    if (!result.ok) {
      return {
        ok: false,
        diff: '',
        message: result.stderr.trim() || '读取 Git 改动失败'
      };
    }

    const untracked = source === 'staged' ? { ok: true, diff: '', message: '' } : await getUntrackedFilesDiff(workspacePath);
    const diff = [result.stdout.trim(), untracked.diff.trim()].filter(Boolean).join('\n');
    return {
      ok: result.ok && untracked.ok,
      diff,
      message: (result.stderr || untracked.message || '').trim()
    };
  });
};
