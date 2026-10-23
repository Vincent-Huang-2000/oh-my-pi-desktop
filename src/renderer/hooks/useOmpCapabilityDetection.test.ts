import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOmpCapabilityDetection } from './useOmpCapabilityDetection';

const effects = vi.hoisted(() => [] as Array<() => void | (() => void)>);
vi.mock('react', () => ({ useEffect: (setup: () => void | (() => void)) => effects.push(setup) }));
afterEach(() => {
  effects.length = 0;
  vi.unstubAllGlobals();
});

function deferred() {
  let resolve!: (result: OmpCapabilitiesResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<OmpCapabilitiesResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('OMP 自动能力检测的启动与失效', () => {
  it('有执行目录即可检测，无需选中会话或发送消息', async () => {
    const detect = vi.fn().mockResolvedValue({ ok: true, configOptions: [], commands: [] });
    vi.stubGlobal('window', { ohMyPiDesktop: { detectOmpCapabilities: detect } });
    const setDetected = vi.fn();
    useOmpCapabilityDetection('/project', '/omp', 0, { current: 0 }, setDetected);
    effects[0]();
    await Promise.resolve();
    expect(detect).toHaveBeenCalledWith('/project');
    expect(setDetected).toHaveBeenLastCalledWith({
      projectPath: '/project',
      ompPath: '/omp',
      result: { ok: true, configOptions: [], commands: [] },
    });
  });

  it('更换 OMP 后自动重新请求，旧结果晚到也不能覆盖新结果', async () => {
    const old = deferred();
    const next = deferred();
    const detect = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    vi.stubGlobal('window', { ohMyPiDesktop: { detectOmpCapabilities: detect } });
    const setDetected = vi.fn();
    const request = { current: 0 };
    useOmpCapabilityDetection('/project', '/old-omp', 0, request, setDetected);
    const cleanup = effects[0]();
    if (cleanup) cleanup();
    useOmpCapabilityDetection('/project', '/new-omp', 1, request, setDetected);
    effects[1]();
    next.resolve({ ok: true, commands: [{ name: 'guided-goal', description: '' }] });
    await Promise.resolve();
    old.resolve({ ok: false });
    await Promise.resolve();
    expect(detect).toHaveBeenCalledTimes(2);
    expect(setDetected).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ompPath: '/new-omp',
        result: { ok: true, commands: [{ name: 'guided-goal', description: '' }] },
      }),
    );
  });

  it('重新选择相同路径时也重检；失效操作立即阻止旧请求回填', async () => {
    const old = deferred();
    const detect = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ ok: false });
    vi.stubGlobal('window', { ohMyPiDesktop: { detectOmpCapabilities: detect } });
    const setDetected = vi.fn();
    const request = { current: 0 };
    useOmpCapabilityDetection('/project', '/omp', 0, request, setDetected);
    effects[0]();
    request.current += 1;
    old.resolve({ ok: true });
    await Promise.resolve();
    expect(setDetected).toHaveBeenCalledTimes(1);
    useOmpCapabilityDetection('/project', '/omp', 1, request, setDetected);
    effects[1]();
    await Promise.resolve();
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('检测请求失败不写入“不支持”结果', async () => {
    const detect = vi.fn().mockRejectedValue(new Error('IPC unavailable'));
    vi.stubGlobal('window', { ohMyPiDesktop: { detectOmpCapabilities: detect } });
    const setDetected = vi.fn();
    useOmpCapabilityDetection('/project', '/omp', 0, { current: 0 }, setDetected);
    effects[0]();
    await Promise.resolve();
    expect(setDetected.mock.calls).toEqual([[null]]);
  });
});
