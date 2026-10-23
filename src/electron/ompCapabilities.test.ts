import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeOmpCapabilities } from './ompCapabilities.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), mkdtemp: vi.fn(), rm: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({ mkdtemp: mocks.mkdtemp, rm: mocks.rm }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function startProbe() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: { resume: vi.fn() },
    stdin: Object.assign(new EventEmitter(), {
      write: vi.fn<(line: string) => boolean>(() => true),
      end: vi.fn(),
    }),
    kill: vi.fn(),
  });
  child.stdin.end.mockImplementation(() => child.emit('close', 0));
  child.kill.mockImplementation(() => child.emit('close', 0));
  mocks.spawn.mockReturnValue(child);
  mocks.mkdtemp.mockResolvedValue('/tmp/omp-probe-test');
  mocks.rm.mockResolvedValue(undefined);
  const probing = probeOmpCapabilities('/custom/omp', '/project');
  await Promise.resolve();
  const send = (message: unknown) =>
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
  const requests = () =>
    child.stdin.write.mock.calls.map(
      ([line]) => JSON.parse(line) as { id: number; method: string },
    );
  return { child, probing, send, requests };
}

const response = (id: number, result: unknown) => ({ jsonrpc: '2.0', id, result });
const commandUpdate = (commands: string[]) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 'probe',
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: commands.map((name) => ({ name, description: name })),
    },
  },
});
const configOptions = [
  { id: 'mode', name: 'Mode', type: 'select', options: [{ value: 'goal', name: 'Goal' }] },
];

describe('启动时独立探测 OMP 能力', () => {
  it('无历史会话也能完成握手、认证和能力读取，不发送 prompt，退出后清理临时目录', async () => {
    const { probing, send, requests, child } = await startProbe();
    send(response(1, { authMethods: [{ id: 'agent' }] }));
    send(response(2, {}));
    send(response(3, { sessionId: 'probe', configOptions }));
    send(commandUpdate(['goal', 'guided-goal', 'vibe']));
    const result = await probing;
    expect(result).toMatchObject({ ok: true, configOptions });
    expect(result.commands?.map((command) => command.name)).toEqual([
      'goal',
      'guided-goal',
      'vibe',
    ]);
    expect(requests().map((request) => request.method)).toEqual([
      'initialize',
      'authenticate',
      'session/new',
    ]);
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/custom/omp',
      ['acp', '--session-dir', '/tmp/omp-probe-test'],
      expect.objectContaining({ cwd: '/project', windowsHide: true }),
    );
    expect(child.stdin.end).toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith('/tmp/omp-probe-test', { recursive: true, force: true });
  });

  it('命令通知早于 session/new 响应时仍正确获取；空列表表示实际未提供命令', async () => {
    const { probing, send } = await startProbe();
    send(response(1, {}));
    send(commandUpdate([]));
    send(response(3, { sessionId: 'probe', configOptions: [] }));
    await expect(probing).resolves.toEqual({ ok: true, configOptions: [], commands: [] });
  });

  it('进程启动失败时保持未知，不把失败当成不支持', async () => {
    const { probing, child } = await startProbe();
    child.emit('error', new Error('ENOENT'));
    await expect(probing).resolves.toEqual({ ok: false });
    expect(mocks.rm).toHaveBeenCalled();
  });

  it('超时结束探测，不把缺失的命令通知判定为空列表', async () => {
    vi.useFakeTimers();
    const { probing, send } = await startProbe();
    send(response(1, {}));
    send(response(3, { sessionId: 'probe', configOptions }));
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(probing).resolves.toEqual({ ok: true, configOptions, commands: undefined });
  });

  it('握手错误同样释放进程和临时目录', async () => {
    const { probing, send, child } = await startProbe();
    send({ jsonrpc: '2.0', id: 1, error: { message: 'bad handshake' } });
    await expect(probing).resolves.toEqual({ ok: false });
    expect(child.stdin.end).toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalled();
  });
});
