import { spawn } from 'node:child_process';
import type { CommandResult } from './types.js';

export const runCommand = (command: string, args: string[], cwd?: string, timeoutMs = 6000) =>
  new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, { cwd });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout, stderr: stderr || '命令检测超时', code: null });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({ ok: false, stdout, stderr: error.message, code: null });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, stdout, stderr, code });
    });
  });

