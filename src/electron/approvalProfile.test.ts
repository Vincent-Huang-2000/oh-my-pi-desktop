/**
 * approvalProfile.test.ts — 审批档位切换决策函数的单元测试。
 *
 * 不依赖 Electron 运行时、文件系统或子进程。
 */
import { describe, expect, it, vi } from 'vitest';

// state.ts 依赖 electron 模块；mock 后再导入 normalizeApprovalProfile。
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/test-user-data',
  },
}));

import { normalizeApprovalProfile, defaultApprovalProfile } from './state.js';
import {
  decideApprovalProfileAction,
  getPendingApprovalProfile,
  hasPendingForProcess,
  isProcessIdle,
} from './approvalProfile.js';
import type { ApprovalProfileAction } from './approvalProfile.js';
import type { StoredSession } from './types.js';
import type { AcpProcessState } from './agentTypes.js';

// ── 测试辅助：构造最小 AcpProcessState ──

const makeProcessState = (overrides: Partial<AcpProcessState> = {}): AcpProcessState =>
  ({
    child: {},
    localSessionId: 'test-session',
    localSessionTitle: 'Test',
    workspacePath: '/tmp/test',
    lineBuffer: '',
    nextRequestId: 1,
    pendingRequests: new Map(),
    ready: Promise.resolve(),
    initMethod: 'session/load',
    configOptions: [],
    availableCommands: [],
    closed: false,
    isReplaying: false,
    replayEvents: [],
    turnActive: false,
    questionnaireFollowUps: [],
    ...overrides,
  }) as AcpProcessState;

// ── 测试辅助：构造最小 StoredSession ──

const makeStoredSession = (overrides: Partial<StoredSession> = {}): StoredSession => ({
  id: 'test-session',
  projectPath: '/tmp/test',
  title: 'Test Session',
  updatedAt: new Date().toISOString(),
  approvalProfile: 'write',
  acpSessionId: 'acp-123',
  ...overrides,
});

// ── 1. normalizeApprovalProfile 边界值测试 ──

describe('normalizeApprovalProfile', () => {
  it('通过合法值 "always-ask"', () => {
    expect(normalizeApprovalProfile('always-ask')).toBe('always-ask');
  });

  it('通过合法值 "write"', () => {
    expect(normalizeApprovalProfile('write')).toBe('write');
  });

  it('通过合法值 "yolo"', () => {
    expect(normalizeApprovalProfile('yolo')).toBe('yolo');
  });

  it('undefined 回退到 defaultApprovalProfile', () => {
    expect(normalizeApprovalProfile(undefined)).toBe(defaultApprovalProfile);
  });

  it('null 回退到 defaultApprovalProfile', () => {
    expect(normalizeApprovalProfile(null)).toBe(defaultApprovalProfile);
  });

  it('未知字符串回退到 defaultApprovalProfile', () => {
    expect(normalizeApprovalProfile('unknown')).toBe(defaultApprovalProfile);
  });

  it('空字符串回退到 defaultApprovalProfile', () => {
    expect(normalizeApprovalProfile('')).toBe(defaultApprovalProfile);
  });
});

// ── 2. hasPendingForProcess 测试 ──

describe('hasPendingForProcess', () => {
  const process = makeProcessState();
  const otherProcess = makeProcessState({ localSessionId: 'other' });

  it('空 Map → false', () => {
    expect(hasPendingForProcess(new Map(), process)).toBe(false);
  });

  it('Map 中只有其他进程的记录 → false', () => {
    const map = new Map([['r1', { process: otherProcess }]]);
    expect(hasPendingForProcess(map, process)).toBe(false);
  });

  it('Map 中有目标进程的记录 → true', () => {
    const map = new Map([['r1', { process }]]);
    expect(hasPendingForProcess(map, process)).toBe(true);
  });

  it('Map 中同时有其他进程和目标进程 → true', () => {
    const map = new Map([
      ['r1', { process: otherProcess }],
      ['r2', { process }],
    ]);
    expect(hasPendingForProcess(map, process)).toBe(true);
  });
});

// ── 3. isProcessIdle 判定测试 ──

describe('isProcessIdle', () => {
  const process = makeProcessState();
  const permMap = new Map<string, { process: AcpProcessState }>();
  const elicMap = new Map<string, { process: AcpProcessState }>();

  it('全部空闲 → true', () => {
    expect(isProcessIdle(process, permMap, elicMap)).toBe(true);
  });

  it('turnActive: true → false', () => {
    const busy = makeProcessState({ turnActive: true });
    expect(isProcessIdle(busy, permMap, elicMap)).toBe(false);
  });

  it('pendingPermissions 中有该 process → false', () => {
    const map = new Map([['r1', { process }]]);
    expect(isProcessIdle(process, map, elicMap)).toBe(false);
  });

  it('pendingElicitations 中有该 process → false', () => {
    const map = new Map([['r1', { process }]]);
    expect(isProcessIdle(process, permMap, map)).toBe(false);
  });

  it('questionnaireFollowUps 非空 → false', () => {
    const busy = makeProcessState({
      questionnaireFollowUps: [{ requestId: 'q1', text: 'follow-up' }],
    });
    expect(isProcessIdle(busy, permMap, elicMap)).toBe(false);
  });

  it('多个忙条件同时满足 → false', () => {
    const permWithProc = new Map([['r1', { process }]]);
    const busy = makeProcessState({
      turnActive: true,
      questionnaireFollowUps: [{ requestId: 'q1', text: 'follow-up' }],
    });
    expect(isProcessIdle(busy, permWithProc, elicMap)).toBe(false);
  });
});

// ── 4. decideApprovalProfileAction 决策函数测试 ──

describe('decideApprovalProfileAction', () => {
  it('storedSession 不存在 → noop', () => {
    const action = decideApprovalProfileAction(undefined, makeProcessState());
    expect(action.kind).toBe('noop');
  });

  it('acpSessionId 为空 → noop', () => {
    const session = makeStoredSession({ acpSessionId: undefined });
    const action = decideApprovalProfileAction(session, makeProcessState());
    expect(action.kind).toBe('noop');
  });

  it('acpSessionId 存在、进程不存在 → noop', () => {
    const session = makeStoredSession({ approvalProfile: 'yolo' });
    const action = decideApprovalProfileAction(session, undefined);
    expect(action.kind).toBe('noop');
  });

  it('进程已关闭 → noop', () => {
    const session = makeStoredSession({ approvalProfile: 'write' });
    const action = decideApprovalProfileAction(session, makeProcessState({ closed: true }));
    expect(action.kind).toBe('noop');
  });

  it('session approvalProfile 未定义时回退到 write，进程不存在 → noop', () => {
    const session = makeStoredSession({ approvalProfile: undefined });
    const action = decideApprovalProfileAction(session, undefined);
    expect(action.kind).toBe('noop');
  });

  it('进程存在且未关闭 → defer（无论是否活跃回合）', () => {
    const session = makeStoredSession({ approvalProfile: 'write' });
    const action = decideApprovalProfileAction(
      session,
      makeProcessState({ turnActive: true }),
    ) as Extract<ApprovalProfileAction, { kind: 'defer' }>;
    expect(action).toEqual({ kind: 'defer', approvalProfile: 'write' });
  });

  it.each([
    ['请求批准', 'always-ask'],
    ['自动编辑', 'write'],
    ['完全访问', 'yolo'],
  ] as const)('%s 档位 → defer', (_label, profile) => {
    const action = decideApprovalProfileAction(
      makeStoredSession({ approvalProfile: profile }),
      makeProcessState(),
    ) as Extract<ApprovalProfileAction, { kind: 'defer' }>;
    expect(action).toEqual({ kind: 'defer', approvalProfile: profile });
  });
});

// ── 5. getPendingApprovalProfile 测试 ──

describe('getPendingApprovalProfile', () => {
  it('pendingApprovalProfile 为 undefined → undefined', () => {
    const process = makeProcessState();
    expect(getPendingApprovalProfile(process)).toBeUndefined();
  });

  it('pendingApprovalProfile 为 "yolo" → "yolo"', () => {
    const process = makeProcessState({ pendingApprovalProfile: 'yolo' });
    expect(getPendingApprovalProfile(process)).toBe('yolo');
  });

  it('pendingApprovalProfile 为 "always-ask" → "always-ask"', () => {
    const process = makeProcessState({ pendingApprovalProfile: 'always-ask' });
    expect(getPendingApprovalProfile(process)).toBe('always-ask');
  });

  it('pendingApprovalProfile 为 "write" → "write"', () => {
    const process = makeProcessState({ pendingApprovalProfile: 'write' });
    expect(getPendingApprovalProfile(process)).toBe('write');
  });
});
