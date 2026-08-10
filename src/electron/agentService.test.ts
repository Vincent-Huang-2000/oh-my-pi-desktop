/**
 * agentService.test.ts — 审批档位竞态修复的确定性测试。
 *
 * 使用 vitest mock 提供可控的 ACP 子进程和内存 state，不依赖真实 omp 或定时等待。
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── 可被测试文件顶层引用的 hoisted 状态 ──

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (s: string) => void };
  kill: ReturnType<typeof vi.fn>;
};

type SpawnRecord = {
  executable: string;
  args: string[];
  cwd: string;
  child: MockChild;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdinWrites: string[];
};

type MemorySession = {
  id: string;
  projectPath: string;
  title: string;
  acpSessionId?: string;
  approvalProfile?: string;
  updatedAt?: string;
};

const { hoistedSpawns, hoistedMemoryState, defaultApprovalProfile, normalizeApprovalProfile } =
  vi.hoisted(() => {
    const spawns: SpawnRecord[] = [];

    const makeChild = (): {
      child: MockChild;
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdinWrites: string[];
    } => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const stdinWrites: string[] = [];

      const child = new EventEmitter() as MockChild;
      child.stdout = stdout;
      child.stderr = stderr;
      child.stdin = {
        write(s: string) {
          stdinWrites.push(s);
        },
      };
      child.kill = vi.fn();
      return { child, stdout, stderr, stdinWrites };
    };

    const memoryState: {
      settings: Record<string, unknown>;
      recentSessions: MemorySession[];
      logs: Array<{ sessionId: string; level: string; message: string }>;
    } = {
      settings: {},
      recentSessions: [],
      logs: [],
    };

    return {
      hoistedSpawns: spawns,
      hoistedMemoryState: memoryState,
      makeChild,
      defaultApprovalProfile: 'write' as const,
      normalizeApprovalProfile: (v: unknown) => {
        if (typeof v === 'string' && ['always-ask', 'write', 'yolo'].includes(v)) {
          return v as 'always-ask' | 'write' | 'yolo';
        }
        return 'write' as const;
      },
    };
  });

// ── Mock node:child_process ──

vi.mock('node:child_process', () => ({
  spawn(executable: string, args: string[], options: { cwd: string }) {
    const out = new EventEmitter();
    const err = new EventEmitter();
    const writes: string[] = [];
    const c = new EventEmitter() as MockChild;
    c.stdout = out;
    c.stderr = err;
    c.stdin = {
      write(s: string) {
        writes.push(s);
      },
    };
    c.kill = vi.fn();
    const rec: SpawnRecord = {
      executable,
      args,
      cwd: options.cwd,
      child: c,
      stdout: out,
      stderr: err,
      stdinWrites: writes,
    };
    hoistedSpawns.push(rec);
    return c;
  },
}));

// ── Mock electron ──

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-user-data' },
}));

// ── Mock ./state.js ──
vi.mock('./state.js', () => {
  const s = hoistedMemoryState;
  return {
    defaultApprovalProfile,
    normalizeApprovalProfile,
    readState: () => ({
      settings: s.settings,
      recentSessions: s.recentSessions.map((item: MemorySession) => ({ ...item })),
      projects: [],
      logs: s.logs,
    }),
    writeState: () => {},
    getSetting: (_key: string) => undefined,
    updateSessionApprovalProfile: (id: string, profile: string) => {
      const existing = s.recentSessions.find((item: MemorySession) => item.id === id);
      if (!existing) return null;
      const updated: MemorySession = { ...existing, approvalProfile: profile };
      s.recentSessions = s.recentSessions.map((item: MemorySession) =>
        item.id === id ? updated : item,
      );
      return { ...updated };
    },
    upsertSession: (
      workspacePath: string,
      id: string,
      title: string,
      acpSessionId?: string,
      _updatedAt?: string,
      _preserveOrder?: boolean,
      approvalProfile?: string,
    ) => {
      const existing = s.recentSessions.find((item: MemorySession) => item.id === id);
      const session: MemorySession = {
        id,
        projectPath: workspacePath,
        title,
        acpSessionId: acpSessionId ?? existing?.acpSessionId,
        approvalProfile: approvalProfile ?? existing?.approvalProfile,
        updatedAt: new Date().toISOString(),
      };
      s.recentSessions = [
        session,
        ...s.recentSessions.filter((item: MemorySession) => item.id !== id),
      ];
      return { ...session };
    },
    addLog: () => {},
    removeSession: (id: string) => {
      s.recentSessions = s.recentSessions.filter((item: MemorySession) => item.id !== id);
    },
    updateProjectConfigCache: () => {},
    saveToolModelSnapshot: () => {},
    copyToolModelSnapshots: () => {},
    getToolModelSnapshot: () => undefined,
  };
});

// ── 导入被测模块 ──

import { createAgentService } from './agentService.js';
import type { AgentEvent } from './types.js';

// ── 辅助 ──

type EmittedEvent = { type: string; sessionId: string; message: string };

const makeSender = (events: EmittedEvent[]) =>
  vi.fn((event: AgentEvent) => {
    events.push({ type: event.type, sessionId: event.sessionId, message: event.message });
  });

beforeEach(() => {
  hoistedMemoryState.recentSessions = [];
  hoistedMemoryState.settings = {};
  hoistedMemoryState.logs = [];
  hoistedSpawns.length = 0;
});

// ── 1. FIFO 排队测试 ──

describe('updateApprovalProfile FIFO 与代际跳过', () => {
  it('第二次切换档位时，第一次的 stop/start 被代际跳过，仅第二次执行进程重建', async () => {
    const events: EmittedEvent[] = [];
    const svc = createAgentService(makeSender(events));

    hoistedMemoryState.recentSessions = [
      {
        id: 's1',
        projectPath: '/tmp/test-workspace',
        title: 'Test',
        acpSessionId: 'acp-old',
        approvalProfile: 'write',
        updatedAt: new Date().toISOString(),
      },
    ];

    // p1 被 p2 抢先递增 generation → 跳过了 stop/start
    const p1 = svc.updateApprovalProfile('s1', '/tmp/test-workspace', 'always-ask');
    const p2 = svc.updateApprovalProfile('s1', '/tmp/test-workspace', 'yolo');

    // p1 跳过 stop/start → 没有 spawn，直接返回
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(hoistedSpawns.length).toBe(0);

    // p2 执行 stop/start → spawn child
    await new Promise((r) => setTimeout(r, 0));
    expect(hoistedSpawns.length).toBe(1);

    // 让 p2 的 child 完成
    const rec = hoistedSpawns[0];
    rec.child.emit('close', 0);
    await new Promise((r) => setTimeout(r, 0));

    await p2;

    // 最终持久化档位为 yolo（最后一次请求的值）
    const final = hoistedMemoryState.recentSessions.find((s) => s.id === 's1');
    expect(final?.approvalProfile).toBe('yolo');
  });

  it('连续三次切换档位，前两次的 stop/start 均被跳过', async () => {
    const events: EmittedEvent[] = [];
    const svc = createAgentService(makeSender(events));

    hoistedMemoryState.recentSessions = [
      {
        id: 's1',
        projectPath: '/tmp/test-workspace',
        title: 'Test',
        acpSessionId: 'acp-old',
        approvalProfile: 'write',
        updatedAt: new Date().toISOString(),
      },
    ];

    const p1 = svc.updateApprovalProfile('s1', '/tmp/test-workspace', 'always-ask');
    const p2 = svc.updateApprovalProfile('s1', '/tmp/test-workspace', 'write');
    const p3 = svc.updateApprovalProfile('s1', '/tmp/test-workspace', 'yolo');

    // p1 跳过、p2 也跳过 — 均无 spawn
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect(hoistedSpawns.length).toBe(0);

    // p3 执行 stop/start
    await new Promise((r) => setTimeout(r, 0));
    expect(hoistedSpawns.length).toBe(1);

    const rec = hoistedSpawns[0];
    rec.child.emit('close', 0);
    await new Promise((r) => setTimeout(r, 0));

    await p3;

    const final = hoistedMemoryState.recentSessions.find((s) => s.id === 's1');
    expect(final?.approvalProfile).toBe('yolo');
  });
});

// ── 2. startAgent catch 身份检查测试 ──

describe('startAgent catch 身份检查', () => {
  it('旧 initialize 失败时，不在 agentProcesses 已被替换时发出 error 事件', async () => {
    const events: EmittedEvent[] = [];
    const svc = createAgentService(makeSender(events));

    // 发起 startAgent — mock child 的 initialize 永不响应
    void svc.startAgent('s1', '/tmp/test-workspace', 'write');

    await new Promise((r) => setTimeout(r, 0));
    expect(hoistedSpawns.length).toBe(1);

    // 用 stopSessionProcess 杀掉进程 — close 事件会 reject pending initialize
    svc.stopSessionProcess('s1');
    await new Promise((r) => setTimeout(r, 0));

    // 旧 catch 不应发出 error 事件（agentProcesses 已被 stop 清理）
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(0);

    // 清理
    svc.stopSessionProcess('s1');
  });
});
