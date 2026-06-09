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
  const remoteUrl = 'https://raw.githubusercontent.com/issaghostlife/instatakker-app/main/instatakker-core.js';
  const localPath = path.join(__dirname, 'instatakker-core.js');
  const cachePath = path.join(app.getPath('userData'), 'instatakker-core-cache.js');

  try {
    console.log('[APP] Checking latest Instatakker core from GitHub...');

    const res = await fetch(remoteUrl, {
      headers: {
        'Cache-Control': 'no-cache',
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub returned ${res.status}`);
    }

    const script = await res.text();

    if (!script || !script.includes('Instatakker')) {
      throw new Error('Downloaded script did not look valid');
    }

    fs.writeFileSync(cachePath, script, 'utf8');
    console.log('[APP] Loaded latest core from GitHub');

    return script;
  } catch (err) {
    console.log('[APP] Could not load remote core. Using backup.', err.message);

    if (fs.existsSync(cachePath)) {
      console.log('[APP] Using cached core script');
      return fs.readFileSync(cachePath, 'utf8');
    }

    if (fs.existsSync(localPath)) {
      console.log('[APP] Using bundled local core script');
      return fs.readFileSync(localPath, 'utf8');
    }

    console.log('[ERROR] No core script available');
    return '';
  }
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