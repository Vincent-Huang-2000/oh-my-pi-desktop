/**
 * agentService.test.ts — 审批档位竞态修复的确定性测试。
 *
 * 使用 vitest mock 提供可控的 ACP 子进程和内存 state，不依赖真实 omp 或定时等待。
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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
import type { AgentService } from './agentTypes.js';
import type { AgentEvent } from './types.js';

// ── 辅助 ──

type EmittedEvent = {
  type: AgentEvent['type'];
  sessionId: string;
  message: string;
  payload?: unknown;
};

type AgentEventListener = (event: EmittedEvent) => void;

const makeSender = (events: EmittedEvent[], onEvent?: AgentEventListener) =>
  vi.fn((event: AgentEvent) => {
    const emitted = {
      type: event.type,
      sessionId: event.sessionId,
      message: event.message,
      payload: event.payload,
    };
    events.push(emitted);
    onEvent?.(emitted);
  });

beforeEach(() => {
  hoistedMemoryState.recentSessions = [];
  hoistedMemoryState.settings = {};
  hoistedMemoryState.logs = [];
  hoistedSpawns.length = 0;
});

const originalPlanAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryPlanRoots: string[] = [];

afterEach(async () => {
  if (originalPlanAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalPlanAgentDir;
  }
  await Promise.all(
    temporaryPlanRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createPlanLocalDirectory = async (acpSessionId: string) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'omp-desktop-plan-'));
  temporaryPlanRoots.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const localDir = path.join(agentDir, 'sessions', 'project', `session_${acpSessionId}`, 'local');
  await mkdir(localDir, { recursive: true });
  return localDir;
};

const emitAcpMessage = (record: SpawnRecord, message: unknown) => {
  const serialized = `${JSON.stringify(message)}\n`;
  record.stdout.emit('data', Buffer.from(serialized));
};

const startInitializedAgent = async (
  service: AgentService,
  sessionId: string,
  workspacePath: string,
) => {
  const starting = service.startAgent(sessionId, workspacePath, 'write');
  const record = hoistedSpawns[0];
  const initializeRequest = JSON.parse(record.stdinWrites[0]) as { id: string | number | null };
  emitAcpMessage(record, { jsonrpc: '2.0', id: initializeRequest.id, result: {} });
  await starting;
  return record;
};

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

describe('xd://propose Plan 审批关联', () => {
  it('只为已关联的 Plan 审批加载完整方案，普通 elicitation 不复用旧方案', async () => {
    const acpSessionId = 'acp-plan';
    const localDir = await createPlanLocalDirectory(acpSessionId);
    await writeFile(path.join(localDir, 'auth-plan.md'), '# Auth plan\n\n完整方案内容');
    hoistedMemoryState.recentSessions = [
      {
        id: 'plan-session',
        projectPath: '/tmp/test-workspace',
        title: 'Plan',
        acpSessionId,
        approvalProfile: 'write',
        updatedAt: new Date().toISOString(),
      },
    ];

    const events: EmittedEvent[] = [];
    let resolvePlanPreview: ((event: EmittedEvent) => void) | undefined;
    const planPreview = new Promise<EmittedEvent>((resolve) => {
      resolvePlanPreview = resolve;
    });
    const service = createAgentService(
      makeSender(events, (event) => {
        if (event.type === 'elicitation_plan_preview') {
          resolvePlanPreview?.(event);
        }
      }),
    );
    const record = await startInitializedAgent(service, 'plan-session', '/tmp/test-workspace');

    emitAcpMessage(record, {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'proposal-1',
          title: 'xd://propose',
          status: 'pending',
          rawInput: { path: 'xd://propose', content: 'auth' },
        },
      },
    });
    expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({
      planProposal: { toolCallId: 'proposal-1', title: 'auth' },
    });

    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: 'plan-request',
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Approve plan "auth" and start implementation?\n\n# Auth plan\n',
        requestedSchema: {
          properties: {
            value: { type: 'string', enum: ['Approve and execute', 'Refine plan'] },
          },
        },
      },
    });
    const preview = await planPreview;
    expect(preview.payload).toMatchObject({
      requestId: 'plan-session-plan-request',
      fullPlan: '# Auth plan\n\n完整方案内容',
      planFilePath: 'local://auth-plan.md',
    });

    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: 'tool-request',
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Allow tool: bash\n\n# 这不是方案',
        requestedSchema: { properties: { value: { type: 'boolean' } } },
      },
    });
    const genericRequest = events.find(
      (event) =>
        event.type === 'elicitation_request' &&
        event.payload !== null &&
        typeof event.payload === 'object' &&
        (event.payload as Record<string, unknown>).requestId === 'plan-session-tool-request',
    );
    expect(genericRequest?.payload).not.toHaveProperty('planProposal');
    expect(events.filter((event) => event.type === 'elicitation_plan_preview')).toHaveLength(1);

    emitAcpMessage(record, {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: acpSessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' },
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'active_plan_update',
      payload: { version: 1, active: false },
    });
  });
});

describe('P1 方案审核与新会话接续', () => {
  const review = {
    reviewId: 'review-1',
    planFilePath: 'local://auth-plan.md',
    title: 'Auth',
    content: '# Auth\n完整计划',
    feedback: '',
    options: ['execute', 'compact', 'keep', 'refine', 'save'].map((id) => ({ id })),
  };
  const requestOf = (record: SpawnRecord, method: string) =>
    record.stdinWrites
      .map(
        (line) =>
          JSON.parse(line) as { id: string; method?: string; params?: Record<string, unknown> },
      )
      .filter((message) => message.method === method)
      .at(-1)!;
  const setup = async () => {
    const events: EmittedEvent[] = [];
    const service = createAgentService(makeSender(events));
    const record = await startInitializedAgent(service, 's1', '/tmp/test-workspace');
    const sending = service.sendAgentMessage('s1', '/tmp/test-workspace', { text: '请规划' });
    await vi.waitFor(() => expect(requestOf(record, 'session/new')).toBeDefined());
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: requestOf(record, 'session/new').id,
      result: { sessionId: 'acp-old', _meta: { 'omp.planReview': { version: 1, active: false } } },
    });
    await sending;
    const update = (value: unknown, sessionId = 'acp-old') =>
      emitAcpMessage(record, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: value },
      });
    const form = () =>
      emitAcpMessage(record, {
        jsonrpc: '2.0',
        id: 'review-form',
        method: 'elicitation/create',
        params: {
          sessionId: 'acp-old',
          mode: 'form',
          requestedSchema: {
            properties: {
              decision: { oneOf: review.options.map((option) => ({ const: option.id })) },
            },
          },
        },
      });
    return { service, record, events, update, form };
  };
  it('完整通知与表单合为一份审核，禁用提前提交和重复提交', async () => {
    const { service, record, events, update, form } = await setup();
    update({ sessionUpdate: 'plan_review_update', review });
    expect(
      await service.respondPlanReview('s1', review.reviewId, { decision: 'execute' }),
    ).toMatchObject({ ok: false });
    form();
    expect(events.filter((event) => event.type === 'elicitation_request')).toHaveLength(0);
    expect(events.at(-1)?.payload).toMatchObject({ ready: true, review });
    expect(
      await service.respondPlanReview('s1', review.reviewId, {
        decision: 'refine',
        feedback: '补充验证',
        editedContent: '# 新方案',
      }),
    ).toMatchObject({ ok: true });
    expect(JSON.parse(record.stdinWrites.at(-1)!)).toMatchObject({
      id: 'review-form',
      result: {
        action: 'accept',
        content: { decision: 'refine', feedback: '补充验证', editedContent: '# 新方案' },
      },
    });
    expect(
      await service.respondPlanReview('s1', review.reviewId, { decision: 'execute' }),
    ).toMatchObject({ ok: false });
  });
  it('新上下文执行保留规划记录，后续消息和审批使用新会话', async () => {
    const { service, record, events, update, form } = await setup();
    update({ sessionUpdate: 'plan_review_update', review });
    form();
    await service.respondPlanReview('s1', review.reviewId, { decision: 'execute' });
    const oldPrompt = requestOf(record, 'session/prompt');
    update({
      sessionUpdate: 'session_info_update',
      _meta: { 'omp.sessionReplacement': { version: 1, sessionId: 'acp-new' } },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'session_replaced',
      payload: {
        session: { id: 's1', acpSessionId: 'acp-new' },
        previousSession: { acpSessionId: 'acp-old' },
      },
    });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '旧内容' } });
    expect(events.some((event) => event.message === '旧内容')).toBe(false);
    update(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '新内容' } },
      'acp-new',
    );
    expect(events.at(-1)?.message).toBe('新内容');
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: oldPrompt.id,
      result: { stopReason: 'end_turn' },
    });
    await service.sendAgentMessage('s1', '/tmp/test-workspace', { text: '继续' });
    expect(requestOf(record, 'session/prompt').params?.sessionId).toBe('acp-new');
  });
  it('重开审核通过独立 action 执行，只产生一次忙碌开始与结束', async () => {
    const { service, record, events, update } = await setup();
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: requestOf(record, 'session/prompt').id,
      result: { stopReason: 'end_turn' },
    });
    await Promise.resolve();
    const reopening = service.reopenPlanReview('s1', '/tmp/test-workspace');
    await vi.waitFor(() => expect(requestOf(record, 'omp.planReview/reopen')).toBeDefined());
    update({ sessionUpdate: 'plan_review_update', review });
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: requestOf(record, 'omp.planReview/reopen').id,
      result: { ok: true },
    });
    expect(await reopening).toMatchObject({ ok: true });
    expect(events.at(-1)?.payload).toMatchObject({ ready: true });
    await service.respondPlanReview('s1', review.reviewId, { decision: 'keep' });
    const action = requestOf(record, 'omp.planReview/action');
    expect(action.params).toMatchObject({
      sessionId: 'acp-old',
      reviewId: 'review-1',
      decision: 'keep',
    });
    expect(events.filter((event) => event.type === 'plan_review_action_started')).toHaveLength(1);
    emitAcpMessage(record, { jsonrpc: '2.0', id: action.id, result: { ok: false } });
    await Promise.resolve();
    expect(events.at(-1)?.type).toBe('error');
    expect(
      events.filter((event) => event.type === 'plan_review_update').at(-1)?.payload,
    ).toMatchObject({ review, ready: true });
  });
  it('切回运行中的会话不重新加载、不打断待审核表单', async () => {
    const { service, record, events, update, form } = await setup();
    update({ sessionUpdate: 'plan_review_update', review });
    form();
    const writes = record.stdinWrites.length;
    expect(await service.resumeSession('s1', '/tmp/test-workspace', 'acp-old')).toMatchObject({
      ok: true,
    });
    expect(record.stdinWrites).toHaveLength(writes);
    expect(events.at(-1)?.payload).toMatchObject({ review, ready: true });
    expect(
      await service.respondPlanReview('s1', review.reviewId, { decision: 'keep' }),
    ).toMatchObject({ ok: true });
  });
  it('加载持久化待审状态后自动恢复全文，使用 action 而非旧表单', async () => {
    const { service, record, events, update } = await setup();
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: requestOf(record, 'session/prompt').id,
      result: { stopReason: 'end_turn' },
    });
    const loading = service.loadSession('s1', '/tmp/test-workspace', 'acp-old');
    await vi.waitFor(() => expect(requestOf(record, 'session/load')).toBeDefined());
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: requestOf(record, 'session/load').id,
      result: { _meta: { 'omp.planReview': { version: 1, active: true } } },
    });
    await loading;
    expect(requestOf(record, 'omp.planReview/reopen').params?.sessionId).toBe('acp-old');
    update({ sessionUpdate: 'plan_review_update', review });
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: requestOf(record, 'omp.planReview/reopen').id,
      result: { ok: true },
    });
    await Promise.resolve();
    expect(
      events.filter((event) => event.type === 'plan_review_update').at(-1)?.payload,
    ).toMatchObject({ review, ready: true });
    expect(
      await service.respondPlanReview('s1', review.reviewId, {
        decision: 'save',
        savePath: '/tmp/approved-plan.md',
      }),
    ).toMatchObject({ ok: true });
    expect(requestOf(record, 'omp.planReview/action').params).toMatchObject({ decision: 'save' });
  });
  it('切出规划模式会关闭并结算旧表单，普通输入请求仍走原审批', async () => {
    const { service, record, events, update, form } = await setup();
    update({ sessionUpdate: 'plan_review_update', review });
    form();
    update({ sessionUpdate: 'current_mode_update', currentModeId: 'default' });
    expect(
      await service.respondPlanReview('s1', review.reviewId, { decision: 'keep' }),
    ).toMatchObject({ ok: false });
    expect(record.stdinWrites.some((line) => line.includes('"action":"cancel"'))).toBe(true);
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: 'ordinary',
      method: 'elicitation/create',
      params: {
        sessionId: 'acp-old',
        message: '普通工具审批',
        requestedSchema: { properties: { value: { type: 'boolean' } } },
      },
    });
    expect(events.at(-1)?.type).toBe('elicitation_request');
  });
});
