import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CLIENT_VERSION } from './agentTypes.js';
import { isRecord, normalizeConfigOptions } from './agentUtils.js';
import type { AcpAvailableCommand, OmpCapabilitiesResult } from './types.js';

// 使用独立会话目录获取真实的模式和命令，不写入用户对话，也不发送模型 prompt。
export async function probeOmpCapabilities(
  executable: string,
  workspacePath: string,
): Promise<OmpCapabilitiesResult> {
  const sessionDir = await mkdtemp(path.join(tmpdir(), 'omp-capabilities-'));
  try {
    const child = spawn(executable, ['acp', '--session-dir', sessionDir], {
      cwd: workspacePath,
      env: { ...process.env, OMP_WORKSPACE: workspacePath },
      windowsHide: true,
    });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    try {
      return await new Promise<OmpCapabilitiesResult>((resolve) => {
        let settled = false;
        let buffer = '';
        let sessionId: string | undefined;
        let configOptions: OmpCapabilitiesResult['configOptions'];
        let advertised: { sessionId: string; commands: AcpAvailableCommand[] } | undefined;
        const finish = (result: OmpCapabilitiesResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(result);
        };
        const snapshot = (): OmpCapabilitiesResult => ({
          ok: Boolean(sessionId),
          configOptions,
          // 命令通知可以早于 session/new 响应，且不能把缺少通知当成空命令列表。
          commands: advertised?.sessionId === sessionId ? advertised?.commands : undefined,
        });
        const timeout = setTimeout(() => finish(snapshot()), 15_000);
        const send = (id: number, method: string, params: unknown) => {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        };
        const createSession = () => send(3, 'session/new', { cwd: workspacePath, mcpServers: [] });
        const handle = (message: unknown) => {
          if (!isRecord(message) || settled) return;
          if (message.method === 'session/update' && isRecord(message.params)) {
            const { sessionId: updateSessionId, update } = message.params;
            if (
              typeof updateSessionId === 'string' &&
              isRecord(update) &&
              update.sessionUpdate === 'available_commands_update' &&
              Array.isArray(update.availableCommands)
            ) {
              advertised = {
                sessionId: updateSessionId,
                commands: update.availableCommands.filter(isRecord).flatMap((command) =>
                  typeof command.name === 'string'
                    ? [
                        {
                          name: command.name,
                          description:
                            typeof command.description === 'string' ? command.description : '',
                        },
                      ]
                    : [],
                ),
              };
              if (sessionId === updateSessionId) finish(snapshot());
            }
            return;
          }
          if (message.error) {
            finish({ ok: false });
            return;
          }
          if (!isRecord(message.result)) return;
          if (message.id === 1) {
            const auth = message.result.authMethods;
            if (
              Array.isArray(auth) &&
              auth.some((method) => isRecord(method) && method.id === 'agent')
            ) {
              send(2, 'authenticate', { methodId: 'agent' });
            } else createSession();
          } else if (message.id === 2) {
            createSession();
          } else if (message.id === 3 && typeof message.result.sessionId === 'string') {
            sessionId = message.result.sessionId;
            configOptions = normalizeConfigOptions(message.result.configOptions);
            if (advertised?.sessionId === sessionId) finish(snapshot());
          }
        };
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            let message: unknown;
            try {
              message = JSON.parse(line);
            } catch {
              continue;
            }
            handle(message);
          }
        });
        // 只消费诊断输出，避免管道被填满；探测失败不向用户泄露内部错误。
        child.stderr.resume();
        child.once('error', () => finish({ ok: false }));
        child.once('close', () => finish({ ok: false }));
        child.stdin.on('error', () => finish({ ok: false }));
        send(1, 'initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'oh-my-pi-desktop', version: CLIENT_VERSION },
          clientCapabilities: { elicitation: { form: {} }, plan: {} },
        });
      });
    } finally {
      // EOF 让 OMP 正常释放会话，超时再结束子进程；退出后才能安全清理临时目录。
      child.stdin.end();
      const killTimer = setTimeout(() => child.kill(), 1000);
      await closed;
      clearTimeout(killTimer);
    }
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
}
