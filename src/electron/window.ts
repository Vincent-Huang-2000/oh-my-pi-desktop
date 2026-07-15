import { BrowserWindow, shell } from 'electron';
import path from 'node:path';

type CreateWindowOptions = {
  electronDirname: string;
  devServerUrl?: string;
};

export const createWindow = async ({ electronDirname, devServerUrl }: CreateWindowOptions) => {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    title: 'oh-my-pi',
    backgroundColor: '#f6f7f2',
    webPreferences: {
      // 保持渲染层与 Node.js 隔离，只通过 preload 暴露桌面端需要的白名单 API。
      preload: path.join(electronDirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl) {
    await win.loadURL(devServerUrl);
  } else {
    await win.loadFile(path.join(electronDirname, '../dist/index.html'));
  }
};

