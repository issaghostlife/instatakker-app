const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
    icon: path.join(__dirname, 'build', 'icon.ico'),
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.log('[PAGE LOAD ERROR]', errorCode, errorDescription);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[APP] index.html loaded');
  });
}

ipcMain.handle('load-instagram', async () => {
  return 'https://www.instagram.com';
});

ipcMain.handle('get-script', async () => {
  const scriptPath = path.join(__dirname, 'instatakker-core.js');

  if (!fs.existsSync(scriptPath)) {
    console.log('[ERROR] Missing instatakker-core.js at:', scriptPath);
    return '';
  }

  return fs.readFileSync(scriptPath, 'utf8');
});

ipcMain.handle('save-limits', async (event, data) => {
  const limitsPath = path.join(app.getPath('userData'), 'limits.json');
  fs.writeFileSync(limitsPath, JSON.stringify(data, null, 2));
  return true;
});

ipcMain.handle('load-limits', async () => {
  const limitsPath = path.join(app.getPath('userData'), 'limits.json');

  try {
    return JSON.parse(fs.readFileSync(limitsPath, 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('app-quit', () => {
  app.quit();
});

ipcMain.handle('app-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});