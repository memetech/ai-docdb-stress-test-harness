import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { runStressTest } from './stress-test.js';

const electronDirectory = dirname(fileURLToPath(import.meta.url));

function createWindow() {
  const window = new BrowserWindow({
    width: 560,
    height: 240,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(electronDirectory, 'preload.cjs'),
      sandbox: true,
    },
  });
  window.loadFile(join(electronDirectory, 'index.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('stress-test:run', (_event, rawArguments) => runStressTest(rawArguments));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
