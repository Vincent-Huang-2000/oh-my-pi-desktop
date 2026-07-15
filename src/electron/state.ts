import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AcpAvailableCommand,
  AcpConfigOption,
  ApprovalProfile,
  DesktopSettings,
  DesktopState,
  StoredLog,
  StoredProject,
  StoredSession,
  ToolModelSnapshot
} from './types.js';

const stateFileName = 'oh-my-pi-desktop-state.json';

// recentSessions 上限：列表以 omp 为准重建后，单项目可能有数十个会话，放宽以免被截断。
const maxRecentSessions = 200;
export const defaultApprovalProfile: ApprovalProfile = 'write';

export const normalizeApprovalProfile = (value: unknown): ApprovalProfile => {
  return value === 'always-ask' || value === 'write' || value === 'yolo'
    ? value
    : defaultApprovalProfile;
};

const defaultState: DesktopState = {
  recentProjects: [],
  recentSessions: [],
  logs: [],
  configCacheByProjectPath: {},
  toolModelSnapshotsBySession: {},
  settings: {}
};

const getStatePath = () => path.join(app.getPath('userData'), stateFileName);

export const readState = (): DesktopState => {
  try {
    const raw = fs.readFileSync(getStatePath(), 'utf8');
    const state = { ...defaultState, ...JSON.parse(raw) } as DesktopState;
    if (!state.configCacheByProjectPath || typeof state.configCacheByProjectPath !== 'object') {
      state.configCacheByProjectPath = {};
    }
    if (!state.toolModelSnapshotsBySession || typeof state.toolModelSnapshotsBySession !== 'object') {
      state.toolModelSnapshotsBySession = {};
    }
    if (!state.settings || typeof state.settings !== 'object') {
      state.settings = {};
    }
    state.recentSessions = state.recentSessions.map((session) => ({
      ...session,
      approvalProfile: normalizeApprovalProfile(session.approvalProfile)
    }));
    return state;
  } catch {
    return defaultState;
  }
};

export const writeState = (state: DesktopState) => {
  fs.mkdirSync(path.dirname(getStatePath()), { recursive: true });
  fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), 'utf8');
};
// 读取全局设置项；未设置时返回 undefined。
export const getSetting = <K extends keyof DesktopSettings>(key: K): DesktopSettings[K] | undefined => {
  return readState().settings?.[key];
};

// 写入全局设置项。
export const setSetting = <K extends keyof DesktopSettings>(
  key: K,
  value: DesktopSettings[K]
): void => {
  const state = readState();
  writeState({
    ...state,
    settings: { ...state.settings, [key]: value }
  });
};


export const addLog = (sessionId: string, level: StoredLog['level'], message: string) => {
  const state = readState();
  state.logs = [
    {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sessionId,
      level,
      message,
      createdAt: new Date().toISOString()
    },
    ...state.logs
  ].slice(0, 120);
  writeState(state);
};

// 按项目缓存最近一次真实 ACP session 返回的配置。草稿会话不创建 ACP session，
// 因此顶栏先复用这份缓存展示，首次发送时再把用户选择应用到真实 session。
// 写入时保留同项目缓存里的 availableCommands，避免互相覆盖。
export const updateProjectConfigCache = (projectPath: string, configOptions: AcpConfigOption[]) => {
  if (configOptions.length === 0) {
    return readState();
  }
  const state = readState();
  const existing = state.configCacheByProjectPath[projectPath];
  state.configCacheByProjectPath[projectPath] = {
    configOptions,
    availableCommands: existing?.availableCommands ?? [],
    updatedAt: new Date().toISOString()
  };
  writeState(state);
  return state;
};

// 按项目缓存最近一次 ACP available_commands_update 下发的命令列表。
// 新 session 未连上 ACP 时复用这份缓存，让输入 / 立刻有命令可选。
// 写入时保留同项目缓存里的 configOptions，避免互相覆盖。
export const updateProjectCommandsCache = (
  projectPath: string,
  availableCommands: AcpAvailableCommand[]
) => {
  if (availableCommands.length === 0) {
    return readState();
  }
  const state = readState();
  const existing = state.configCacheByProjectPath[projectPath];
  state.configCacheByProjectPath[projectPath] = {
    configOptions: existing?.configOptions ?? [],
    availableCommands,
    updatedAt: new Date().toISOString()
  };
  writeState(state);
  return state;
};

// 记录工具调用发起时的模型快照，用于 session/load 或 resume 回放历史时还原卡片头部模型。
export const saveToolModelSnapshot = (
  acpSessionId: string,
  toolCallId: string,
  model: ToolModelSnapshot
) => {
  if (!acpSessionId || !toolCallId) {
    return readState();
  }
  const state = readState();
  const snapshots = state.toolModelSnapshotsBySession[acpSessionId] ?? {};
  if (snapshots[toolCallId]) {
    return state;
  }
  state.toolModelSnapshotsBySession[acpSessionId] = {
    ...snapshots,
    [toolCallId]: model
  };
  writeState(state);
  return state;
};

export const getToolModelSnapshot = (acpSessionId: string, toolCallId: string) => {
  return readState().toolModelSnapshotsBySession[acpSessionId]?.[toolCallId];
};

// Fork 会生成新的 ACP sessionId，但历史工具调用 id 会跟随复制；这里把源会话快照复制到新会话。
export const copyToolModelSnapshots = (sourceAcpSessionId: string, targetAcpSessionId: string) => {
  if (!sourceAcpSessionId || !targetAcpSessionId || sourceAcpSessionId === targetAcpSessionId) {
    return readState();
  }
  const state = readState();
  const source = state.toolModelSnapshotsBySession[sourceAcpSessionId];
  if (!source || Object.keys(source).length === 0) {
    return state;
  }
  state.toolModelSnapshotsBySession[targetAcpSessionId] = {
    ...source,
    ...(state.toolModelSnapshotsBySession[targetAcpSessionId] ?? {})
  };
  writeState(state);
  return state;
};

export const upsertProject = (workspacePath: string) => {
  const state = readState();
  // 重新 upsert 已存在的项目（如再次通过对话框选中同一目录）时，保留其置顶标记，
  // 否则 displayedProjects 依赖的 pinned 会被抹掉。
  const existing = state.recentProjects.find((item) => item.path === workspacePath);
  const project: StoredProject = {
    path: workspacePath,
    name: path.basename(workspacePath),
    lastOpenedAt: new Date().toISOString(),
    ...(existing?.pinned ? { pinned: true } : {})
  };
  state.recentProjects = [
    project,
    ...state.recentProjects.filter((item) => item.path !== workspacePath)
  ].slice(0, 8);
  writeState(state);
  return project;
};

// 仅更新 lastOpenedAt 字段，不重排 recentProjects 数组顺序。
// 用于「点击 session 进入执行目录」时记录最近操作时间，供启动恢复「上次执行目录」使用，
// 同时保持项目在左栏的显示顺序不变。
export const touchProjectLastOpened = (workspacePath: string) => {
  const state = readState();
  const existing = state.recentProjects.find((item) => item.path === workspacePath);
  if (!existing) {
    return null;
  }
  existing.lastOpenedAt = new Date().toISOString();
  writeState(state);
  return existing;
};
// 设置项目置顶标记；不存在的项目返回 null。持久化顺序保持不变，由渲染层按 pinned 排序展示。
export const setProjectPinned = (workspacePath: string, pinned: boolean) => {
  const state = readState();
  const existing = state.recentProjects.find((item) => item.path === workspacePath);
  if (!existing) {
    return null;
  }
  existing.pinned = pinned;
  writeState(state);
  return existing;
};

// 设置项目自定义显示名；传入空字符串等价于清除（回退到目录名）。不存在的项目返回 null。
export const setProjectDisplayName = (workspacePath: string, displayName: string) => {
  const state = readState();
  const existing = state.recentProjects.find((item) => item.path === workspacePath);
  if (!existing) {
    return null;
  }
  const trimmed = displayName.trim();
  if (trimmed && trimmed !== existing.name) {
    existing.displayName = trimmed;
  } else {
    // 与目录名相同或为空时清掉，避免持久化冗余字段。
    delete existing.displayName;
  }
  writeState(state);
  return existing;
};

// 从 recentProjects 中移除一个项目。按用户约定：只删项目本身，recentSessions 中
// 属于该 projectPath 的会话行保留（再次添加同目录时可能复现），磁盘上 omp 会话不动。
export const removeProject = (workspacePath: string) => {
  const state = readState();
  const existing = state.recentProjects.find((item) => item.path === workspacePath);
  if (!existing) {
    return null;
  }
  state.recentProjects = state.recentProjects.filter((item) => item.path !== workspacePath);
  writeState(state);
  return existing;
};

// 首次启动兜底：在用户文档目录下创建 omp-desktop 文件夹并 upsert 为项目。
// 返回该项目，供渲染端作为默认执行目录使用。
export const ensureDefaultWorkspace = (): StoredProject => {
  const docsDir = app.getPath('documents');
  const workspacePath = path.join(docsDir, 'omp-desktop');
  fs.mkdirSync(workspacePath, { recursive: true });
  return upsertProject(workspacePath);
};

export const upsertSession = (
  projectPath: string,
  id: string,
  title: string,
  acpSessionId?: string,
  updatedAt?: string,
  // 为 true 时只更新字段，不把 session 移动到列表顶部（用于仅加载/恢复历史而非开始对话的场景）。
  preserveOrder?: boolean,
  approvalProfile?: ApprovalProfile
) => {
  const state = readState();
  const existing = state.recentSessions.find((item) => item.id === id);
  const session: StoredSession = {
    id,
    projectPath,
    title,
    acpSessionId: acpSessionId ?? existing?.acpSessionId,
    approvalProfile: normalizeApprovalProfile(approvalProfile ?? existing?.approvalProfile),
    updatedAt: updatedAt ?? existing?.updatedAt ?? new Date().toISOString()
  };
  if (preserveOrder && existing) {
    // 原位更新：替换同位置的元素，不移动到顶部。
    state.recentSessions = state.recentSessions.map((item) => (item.id === id ? session : item));
  } else {
    state.recentSessions = [
      session,
      ...state.recentSessions.filter((item) => item.id !== id)
    ].slice(0, maxRecentSessions);
  }
  writeState(state);
  return session;
};

// 更新会话审批档位；只改当前会话字段，不改变左栏排序。
export const updateSessionApprovalProfile = (id: string, approvalProfile: ApprovalProfile) => {
  const state = readState();
  const existing = state.recentSessions.find((item) => item.id === id);
  if (!existing) {
    return null;
  }
  const session: StoredSession = { ...existing, approvalProfile };
  state.recentSessions = state.recentSessions.map((item) => (item.id === id ? session : item));
  writeState(state);
  return session;
};

// 以 omp 的 session/list 结果为准，重建某个 workspace 的本地会话列表：
// - 按 acpSessionId 去重，一个 omp 会话只保留一行（消灭 session-<ts> 与 acp-<id> 双份）；
// - 复用已有本地 id（优先 keepLocalId）以保持进程/消息缓存的路由不变；
// - omp 中已不存在的行视为幽灵直接丢弃，使列表与 `omp /resume` 一致；
// - 保留当前活动且尚未落盘的草稿（keepLocalId 对应、且不在 omp 列表中的本地行）。
export const reconcileProjectSessions = (
  projectPath: string,
  remote: { sessionId: string; cwd: string; title?: string; updatedAt?: string }[],
  keepLocalId?: string
): DesktopState => {
  const state = readState();
  const others = state.recentSessions.filter((item) => item.projectPath !== projectPath);
  const localForProject = state.recentSessions.filter((item) => item.projectPath === projectPath);

  const rebuilt: StoredSession[] = remote.map((item) => {
    const matches = localForProject.filter((session) => session.acpSessionId === item.sessionId);
    const existing = (keepLocalId && matches.find((session) => session.id === keepLocalId)) || matches[0];
    return {
      id: existing ? existing.id : `acp-${item.sessionId}`,
      projectPath,
      title: item.title ?? existing?.title ?? `session ${item.sessionId.slice(0, 6)}`,
      acpSessionId: item.sessionId,
      approvalProfile: normalizeApprovalProfile(existing?.approvalProfile),
      updatedAt: item.updatedAt ?? existing?.updatedAt ?? new Date().toISOString()
    };
  });

  if (keepLocalId) {
    const draft = localForProject.find((session) => session.id === keepLocalId);
    if (draft && !rebuilt.some((session) => session.id === draft.id)) {
      rebuilt.unshift(draft);
    }
  }

  state.recentSessions = [...rebuilt, ...others].slice(0, maxRecentSessions);
  writeState(state);
  return state;
};

