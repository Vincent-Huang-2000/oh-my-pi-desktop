/**
 * main — Electron 应用入口。
 *
 * 负责：BrowserWindow 创建、IPC 注册、agentService 组装与退出清理。
 * sendAgentEvent 通过 webContents.send 向所有渲染窗口广播 agent 事件。
 *
 * ## 关键不变量
 * - before-quit 必须同时调 agentService.stopAll() 和 flushPendingLogs()，
 *   确保子进程被终止且最后一批日志不丢失。
 * - sendAgentEvent 遍历 BrowserWindow.getAllWindows() 逐窗口推送，多窗口场景同样安全。
 *
 * ## 维护
 * - 新增全局生命周期钩子在此追加。
 * - 不要在此文件内联 agent 管理逻辑——始终走 agentService 接口。
 */
import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAgentService } from './agentService.js';
import { flushPendingLogs } from './state.js';
import { registerDesktopIpcHandlers } from './ipc.js';
import type { AgentEvent } from './types.js';
import { createWindow } from './window.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

const sendAgentEvent = (event: AgentEvent) => {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('agent:event', event);
  });
};

const agentService = createAgentService(sendAgentEvent);

registerDesktopIpcHandlers(agentService);

app.whenReady().then(() => {
  void createWindow({ electronDirname: __dirname, devServerUrl });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow({ electronDirname: __dirname, devServerUrl });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  agentService.stopAll();
  flushPendingLogs();
});

