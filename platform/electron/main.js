'use strict';

// Electron main process: boots the Express manager (server.js) in-process and
// shows it in a BrowserWindow. No vendoring is needed — the app ships with
// node_modules. Local Docker and remote SSH deployments share the same UI.

const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'OpenClaw Manager';
const PORT = Number(process.env.MANAGER_PORT || 18080);
const APP_URL = `http://127.0.0.1:${PORT}/`;

// Instance data lives in a writable per-user directory in packaged builds.
// OPENCLAW_DATA_DIR (if set) points directly at the *instances* directory,
// matching how src/instances.js consumes it.
const instancesDir = () => {
  if (process.env.OPENCLAW_DATA_DIR) return process.env.OPENCLAW_DATA_DIR;
  if (app.isPackaged) return path.join(app.getPath('userData'), 'data', 'instances');
  return path.join(__dirname, '..', 'data', 'instances');
};

let serverModule = null;
let mainWindow = null;
let serverReadyResolve = null;
const serverReady = new Promise((resolve) => { serverReadyResolve = resolve; });

function startServer() {
  const dataRoot = instancesDir();
  if (app.isPackaged && !process.env.OPENCLAW_DATA_DIR && !fs.existsSync(dataRoot)) {
    // The repo's ./data (with existing instances) is a dev asset, not shipped
    // in the asar; migrate it once so a packaged app picks up where dev left off.
    const repoInstances = path.join(__dirname, '..', 'data', 'instances');
    if (fs.existsSync(repoInstances)) {
      try {
        fs.mkdirSync(path.dirname(dataRoot), { recursive: true });
        fs.cpSync(repoInstances, dataRoot, { recursive: true });
        console.log(`[electron] migrated instance data ${repoInstances} -> ${dataRoot}`);
      } catch (err) {
        console.warn(`[electron] data migration failed: ${err.message}`);
      }
    }
  }
  fs.mkdirSync(dataRoot, { recursive: true });
  process.env.OPENCLAW_DATA_DIR = dataRoot;
  serverModule = require(path.join(__dirname, '..', 'server.js'));
  // server.js logs its listen line; piggyback on that to resolve readiness.
  const origLog = console.log.bind(console);
  console.log = (...args) => {
    origLog(...args);
    if (typeof args[0] === 'string' && args[0].includes('listening on http://127.0.0.1')) {
      console.log = origLog;
      serverReadyResolve();
    }
  };
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 640,
    title: APP_NAME,
    backgroundColor: '#faf6f1',
    show: false,
    webPreferences: {
      // The page is our own static app on a loopback-only server; no Node
      // integration is exposed to it, which keeps the gateway pages isolated.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open instance Control UI links (uiUrl, ports 19000+) in the default
  // browser instead of navigating the manager window away.
  const isExternal = (url) => {
    try {
      const u = new URL(url);
      return !(u.hostname === '127.0.0.1' && Number(u.port) === PORT);
    } catch { return true; }
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isExternal(url)) { event.preventDefault(); shell.openExternal(url); }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  try {
    await serverReady;
    await mainWindow.loadURL(APP_URL);
  } catch (err) {
    dialog.showErrorBox('启动失败', `管理服务启动失败：${err.message}`);
    app.quit();
  }
}

function buildMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...(process.platform === 'darwin' ? [{role:'hide'}, {role:'unhide'}] : []),
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '显示', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Single instance lock ──────────────────────────────────────────────────────
// Two managers would fight over the same data dir, ports, and containers.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    startServer();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  // Stop timers and close the HTTP server so the process exits promptly.
  try {
    if (serverModule && serverModule.app) {
      require('../src/monitor').stopLoops();
      require('../src/routes/connections').closeConnections();
      const t = serverModule.app.get('reconcileTimer');
      if (t) clearInterval(t);
      serverModule.app.get('listenServer')?.close();
    }
  } catch { /* quitting anyway */ }
});
