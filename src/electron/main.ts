import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAgentService } from './agentService.js';
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
});

