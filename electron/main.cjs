const { app, BrowserWindow, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.PORT ?? 4317);
const BASE_URL = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

let serverProc = null;
let mainWindow = null;
let lastUpdateStatus = null;

// Push an update-lifecycle event to the renderer (and remember the latest so a
// renderer that subscribes late can still catch up via get-update-status).
function sendUpdateStatus(payload) {
  lastUpdateStatus = payload;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', payload);
  }
}

// Forward electron-updater events so the Settings tab can show real progress
// and a "restart to apply" action instead of a silent background download.
function wireAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ status: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    sendUpdateStatus({ status: 'available', version: info && info.version }),
  );
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ status: 'not-available' }));
  autoUpdater.on('download-progress', (p) =>
    sendUpdateStatus({ status: 'progress', percent: (p && p.percent) || 0 }),
  );
  autoUpdater.on('update-downloaded', (info) =>
    sendUpdateStatus({ status: 'downloaded', version: info && info.version }),
  );
  autoUpdater.on('error', (err) =>
    sendUpdateStatus({ status: 'error', message: (err && err.message) || String(err) }),
  );
}

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    sendUpdateStatus({ status: 'error', message: 'Updates are only available in the installed app.' });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    sendUpdateStatus({ status: 'error', message: (err && err.message) || String(err) });
  }
});

ipcMain.handle('get-update-status', () => lastUpdateStatus);

ipcMain.handle('quit-and-install', () => {
  if (serverProc) serverProc.kill();
  // Reply to the renderer before the app tears itself down to install.
  setImmediate(() => autoUpdater.quitAndInstall());
});

function startServer() {
  // Reuse the existing TypeScript server. ELECTRON_RUN_AS_NODE makes the Electron
  // binary behave like plain Node, and `--import tsx` runs the .ts entry directly.
  // SITEDECK_NO_OPEN stops the server from also launching a system browser.
  serverProc = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src', 'server.ts')], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SITEDECK_NO_OPEN: '1' },
    stdio: 'inherit',
  });
  serverProc.on('error', (err) => console.error('SiteDeck server failed to start:', err));
}

function waitForServer(onReady, tries = 0) {
  const req = http.get(BASE_URL, (res) => {
    res.resume();
    onReady();
  });
  req.on('error', () => {
    if (tries < 75) setTimeout(() => waitForServer(onReady, tries + 1), 200);
    else onReady(); // give up waiting and load anyway
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    title: 'SiteDeck',
    icon: path.join(ROOT, 'build', 'icon.png'),
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    mainWindow = null;
  });

  // Google blocks OAuth inside embedded webviews, so open the consent flow (and any
  // external link) in the user's default browser. The loopback callback still hits
  // our local server, so the token is cached exactly as in the web flow.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.host !== `localhost:${PORT}` || target.pathname.startsWith('/oauth')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadURL(BASE_URL);
}

// Single-instance lock: a second launch focuses the existing window instead of
// starting another server on the same port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    startServer();
    waitForServer(createWindow);
    // Auto-update from GitHub Releases. Wire the event forwarding always so the
    // Settings tab's "Check for updates" works; only auto-check on packaged builds.
    wireAutoUpdater();
    if (app.isPackaged) {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('update check failed:', err);
      });
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (serverProc) serverProc.kill();
});
