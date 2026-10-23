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
    addLog: (sessionId: string, level: string, message: string) => {
      s.logs.push({ sessionId, level, message });
    },
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

describe('ACP 请求撤销', () => {
  it('按进程和 RPC id 撤销审批，仅回复一次取消并拒绝迟到的用户操作', async () => {
    const events: EmittedEvent[] = [];
    const service = createAgentService(makeSender(events));
    const first = await startInitializedAgent(service, 's1', '/tmp/first');
    const starting = service.startAgent('s2', '/tmp/second', 'write');
    const second = hoistedSpawns[1];
    const init = JSON.parse(second.stdinWrites[0]) as { id: string };
    emitAcpMessage(second, { jsonrpc: '2.0', id: init.id, result: {} });
    await starting;
    for (const record of [first, second]) {
      emitAcpMessage(record, {
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: { options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
      });
    }
    const cancellation = { jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 7 } };
    emitAcpMessage(first, cancellation);
    emitAcpMessage(first, cancellation);
    expect(service.respondPermissionOption('s1-7', 'allow').ok).toBe(false);
    expect(service.respondPermissionOption('s2-7', 'allow').ok).toBe(true);
    const replies = first.stdinWrites.map(
      (line) => JSON.parse(line) as { id: unknown; error?: { code: number } },
    );
    expect(replies.filter((reply) => reply.id === 7)).toEqual([
      { jsonrpc: '2.0', id: 7, error: { code: -32800, message: 'Request cancelled' } },
    ]);
    expect(events.filter((event) => event.type === 'request_cancelled')).toEqual([
      {
        sessionId: 's1',
        type: 'request_cancelled',
        message: '输入请求已取消',
        payload: { requestId: 's1-7' },
      },
    ]);
  });

  it('撤销输入表单后不续发问卷答案，未知或格式错误的撤销不影响其余请求', async () => {
    const service = createAgentService(makeSender([]));
    const record = await startInitializedAgent(service, 's1', '/tmp/first');
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: 'form',
      method: 'elicitation/create',
      params: { message: 'Confirm', requestedSchema: { type: 'object', properties: {} } },
    });
    for (const params of [{ id: 'form' }, { requestId: 'unknown' }, { requestId: {} }]) {
      emitAcpMessage(record, { jsonrpc: '2.0', method: '$/cancel_request', params });
    }
    expect(record.stdinWrites).toHaveLength(1);
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      method: '$/cancel_request',
      params: { requestId: 'form' },
    });
    expect(service.respondElicitation('s1-form', 'accept', { value: 'yes' }).ok).toBe(false);
    expect(service.respondQuestionnaire('s1-form', 'submit', []).ok).toBe(false);
    expect(record.stdinWrites).toHaveLength(2);
  });
});

describe('后台任务的进程结束通知', () => {
  it('静默停止时同步通知进程结束，且不写日志', async () => {
    const events: EmittedEvent[] = [];
    const service = createAgentService(makeSender(events));
    await startInitializedAgent(service, 's1', '/tmp/test-workspace');
    const logs = [...hoistedMemoryState.logs];
    service.stopSessionProcess('s1');
    expect(events.at(-1)).toEqual({
      sessionId: 's1',
      type: 'process_stopped',
      message: 'agent 进程已停止',
      payload: undefined,
    });
    expect(hoistedMemoryState.logs).toEqual(logs);
    // 已无进程时重复停止不再发出事件。
    service.stopSessionProcess('s1');
    expect(events.filter((event) => event.type === 'process_stopped')).toHaveLength(1);
  });

  it('进程异常退出时先报告错误，再通知进程结束', async () => {
    const events: EmittedEvent[] = [];
    const service = createAgentService(makeSender(events));
    const record = await startInitializedAgent(service, 's1', '/tmp/test-workspace');
    record.child.emit('close', 1);
    expect(events.slice(-2).map((event) => event.type)).toEqual(['error', 'process_stopped']);
  });
});

describe('ACP 双流隔离与诊断日志', () => {
  it('保留结构化 RPC 错误原因，并兼容缺失或非文本 details', async () => {
    const service = createAgentService(makeSender([]));
    for (const [data, expected] of [
      [{ details: 'No model selected' }, 'Internal error: No model selected'],
      [undefined, 'Internal error'],
      [{ details: { debug: true } }, 'Internal error'],
      [{ details: '   ' }, 'Internal error'],
    ] as const) {
      const starting = service.startAgent('s1', '/tmp/test-workspace', 'write');
      const record = hoistedSpawns.at(-1)!;
      const request = JSON.parse(record.stdinWrites[0]) as { id: string };
      emitAcpMessage(record, {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message: 'Internal error', data },
      });
      expect(await starting).toMatchObject({ ok: false, message: expected });
    }
  });

  it('stdout 半帧与 stderr 交错时仍能完成初始化', async () => {
    const events: EmittedEvent[] = [];
    const service = createAgentService(makeSender(events));
    const starting = service.startAgent('s1', '/tmp/test-workspace', 'write');
    const record = hoistedSpawns[0];
    const request = JSON.parse(record.stdinWrites[0]) as { id: number };
    const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} });
    const split = '{"jsonrpc":"2.0",'.length;
    record.stdout.emit('data', Buffer.from(response.slice(0, split)));
    record.stderr.emit('data', Buffer.from('extension log\n'));
    record.stdout.emit('data', Buffer.from(`${response.slice(split)}\n`));

    expect((await starting).ok).toBe(true);
    expect(events.filter((event) => ['output', 'error'].includes(event.type))).toEqual([]);
    expect(hoistedMemoryState.logs.filter((log) => log.message.includes('extension'))).toEqual([
      { sessionId: 's1', level: 'info', message: '[stderr] extension log' },
    ]);
    service.stopAll();
  });

  it('stderr 残行不混入 stdout，多行诊断和空白不产生业务事件', async () => {
    const events: EmittedEvent[] = [];
    const sender = makeSender(events);
    const service = createAgentService(sender);
    const starting = service.startAgent('s1', '/tmp/test-workspace', 'write');
    const record = hoistedSpawns[0];
    const request = JSON.parse(record.stdinWrites[0]) as { id: number };
    record.stderr.emit('data', Buffer.from('extension '));
    emitAcpMessage(record, { jsonrpc: '2.0', id: request.id, result: {} });
    expect((await starting).ok).toBe(true);
    const baseline = sender.mock.calls.length;
    record.stderr.emit('data', Buffer.from('log\r\n\n  \r\nError: extension diagnostic\nnext\n'));

    expect(sender).toHaveBeenCalledTimes(baseline);
    expect(events.filter((event) => ['output', 'error'].includes(event.type))).toEqual([]);
    expect(hoistedMemoryState.logs.filter((log) => log.message.startsWith('[stderr]'))).toEqual([
      { sessionId: 's1', level: 'info', message: '[stderr] extension log' },
      { sessionId: 's1', level: 'info', message: '[stderr] Error: extension diagnostic' },
      { sessionId: 's1', level: 'info', message: '[stderr] next' },
    ]);
    service.stopAll();
  });

  it('关闭时分别冲刷两条无换行尾行，响应先于 pending 拒绝处理', async () => {
    const events: EmittedEvent[] = [];
    const service = createAgentService(makeSender(events));
    const starting = service.startAgent('s1', '/tmp/test-workspace', 'write');
    const record = hoistedSpawns[0];
    const request = JSON.parse(record.stdinWrites[0]) as { id: number };
    record.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })),
    );
    record.stderr.emit('data', Buffer.from('extension tail'));
    record.child.emit('close', 0);

    expect((await starting).ok).toBe(true);
    expect(events.filter((event) => ['output', 'error'].includes(event.type))).toEqual([]);
    expect(hoistedMemoryState.logs.filter((log) => log.message.includes('extension'))).toEqual([
      { sessionId: 's1', level: 'info', message: '[stderr] extension tail' },
    ]);
  });

  it('停止后的旧进程残行及后到数据不泄漏事件或诊断', async () => {
    const events: EmittedEvent[] = [];
    const sender = makeSender(events);
    const service = createAgentService(sender);
    const record = await startInitializedAgent(service, 's1', '/tmp/test-workspace');
    record.stdout.emit('data', Buffer.from('old stdout'));
    record.stderr.emit('data', Buffer.from('old stderr'));
    service.stopSessionProcess('s1');
    const eventCount = sender.mock.calls.length;
    const logs = [...hoistedMemoryState.logs];
    record.stdout.emit('data', Buffer.from(' late\n'));
    record.stderr.emit('data', Buffer.from(' late\n'));
    record.child.emit('close', 0);

    expect(sender).toHaveBeenCalledTimes(eventCount);
    expect(hoistedMemoryState.logs).toEqual(logs);
    expect(record.child.kill).toHaveBeenCalledOnce();
  });

  it('合法 JSON-RPC error 仍使初始化失败并发出业务错误', async () => {
    const events: EmittedEvent[] = [];
    const service = createAgentService(makeSender(events));
    const starting = service.startAgent('s1', '/tmp/test-workspace', 'write');
    const record = hoistedSpawns[0];
    const request = JSON.parse(record.stdinWrites[0]) as { id: number };
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32603, message: 'initialize failed' },
    });

    expect((await starting).ok).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ sessionId: 's1', type: 'error', message: 'initialize failed' }),
    );
  });

  it.each(['error', 'close'] as const)('进程 %s 仍报告真实失败', async (kind) => {
    const events: EmittedEvent[] = [];
    const service = createAgentService(makeSender(events));
    const record = await startInitializedAgent(service, 's1', '/tmp/test-workspace');
    if (kind === 'error') {
      record.child.emit('error', new Error('child failed'));
    } else {
      record.child.emit('close', 1);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        sessionId: 's1',
        type: 'error',
        message: kind === 'error' ? 'child failed' : 'agent 已退出，代码 1',
      }),
    );
    service.stopAll();
  });
});

// ── 1. FIFO 排队测试 ──

describe('updateApprovalProfile FIFO 与延迟生效', () => {
  it('连续两次切换按请求顺序保存，未发送消息时不启动进程', async () => {
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

    // 切换只保存档位，实际应用统一由下次发送消息触发。
    const p1 = svc.updateApprovalProfile('s1', '/tmp/test-workspace', 'always-ask');
    const p2 = svc.updateApprovalProfile('s1', '/tmp/test-workspace', 'yolo');

    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toMatchObject({ ok: true, session: { approvalProfile: 'always-ask' } });
    expect(r2).toMatchObject({ ok: true, session: { approvalProfile: 'yolo' } });
    expect(hoistedSpawns).toHaveLength(0);

    // 最终持久化档位为 yolo（最后一次请求的值）
    const final = hoistedMemoryState.recentSessions.find((s) => s.id === 's1');
    expect(final?.approvalProfile).toBe('yolo');
  });

  it('连续三次切换均返回各自保存的档位，最终保存最后一次选择', async () => {
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

    const r1 = await p1;
    const r2 = await p2;
    const r3 = await p3;
    expect(r1).toMatchObject({ ok: true, session: { approvalProfile: 'always-ask' } });
    expect(r2).toMatchObject({ ok: true, session: { approvalProfile: 'write' } });
    expect(r3).toMatchObject({ ok: true, session: { approvalProfile: 'yolo' } });
    expect(hoistedSpawns).toHaveLength(0);

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
  it('服务端撤销方案表单后关闭审核，迟到提交不能重新执行方案', async () => {
    const { service, record, events, update, form } = await setup();
    update({ sessionUpdate: 'plan_review_update', review });
    form();
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      method: '$/cancel_request',
      params: { requestId: 'review-form' },
    });
    expect(
      events.filter((event) => event.type === 'plan_review_update').at(-1)?.payload,
    ).toMatchObject({
      review: null,
      ready: false,
    });
    expect(
      await service.respondPlanReview('s1', review.reviewId, { decision: 'execute' }),
    ).toMatchObject({ ok: false });
    expect(JSON.parse(record.stdinWrites.at(-1)!)).toMatchObject({
      id: 'review-form',
      error: { code: -32800 },
    });
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
  it('重开方案执行成功时发出正常回合结束标记，供后台工具继续接收更新', async () => {
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
    await reopening;
    expect(
      await service.respondPlanReview('s1', review.reviewId, { decision: 'keep' }),
    ).toMatchObject({ ok: true });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bg',
      status: 'completed',
      rawOutput: { details: { async: { state: 'running' } } },
    });
    emitAcpMessage(record, {
      jsonrpc: '2.0',
      id: requestOf(record, 'omp.planReview/action').id,
      result: { ok: true },
    });
    await Promise.resolve();
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      message: '方案操作已完成',
      payload: { stopReason: 'end_turn' },
    });
    expect(events.filter((event) => event.type === 'done')).toHaveLength(2);
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bg',
      status: 'completed',
      rawOutput: { details: { async: { state: 'completed' } } },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'tool_call',
      payload: { update: { toolCallId: 'bg', status: 'completed' } },
    });
  });
  it('规划模式退出后，迟到的 action 失败回复不能恢复已经关闭的审核', async () => {
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
    await reopening;
    expect(
      await service.respondPlanReview('s1', review.reviewId, { decision: 'keep' }),
    ).toMatchObject({
      ok: true,
    });
    const action = requestOf(record, 'omp.planReview/action');
    update({ sessionUpdate: 'current_mode_update', currentModeId: 'default' });
    update({ sessionUpdate: 'plan_review_update', review: null });
    emitAcpMessage(record, { jsonrpc: '2.0', id: action.id, result: { ok: false } });
    await Promise.resolve();
    expect(
      events.filter((event) => event.type === 'plan_review_update').at(-1)?.payload,
    ).toMatchObject({
      review: null,
      ready: false,
    });
    expect(
      await service.respondPlanReview('s1', review.reviewId, { decision: 'keep' }),
    ).toMatchObject({
      ok: false,
    });
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
