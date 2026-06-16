const { app, BrowserWindow, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.PORT ?? 4317);
const ROOT = path.join(__dirname, '..');

let serverProc = null;
let mainWindow = null;
let serverPort = null; // the port the server actually bound (announced on its stdout)
let windowOpened = false; // becomes true once a real or error window is shown
let lastUpdateStatus = null;
let updateDownloaded = false; // gate quit-and-install until an update is actually ready

// Only hand http(s) URLs to the OS — never file://, custom protocols, or similar.
function openExternalSafely(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') shell.openExternal(url);
  } catch {
    /* ignore malformed URLs */
  }
}

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
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    sendUpdateStatus({ status: 'downloaded', version: info && info.version });
  });
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
  if (!updateDownloaded) return; // nothing downloaded yet — ignore stray calls
  if (serverProc) serverProc.kill();
  // Reply to the renderer before the app tears itself down to install.
  setImmediate(() => autoUpdater.quitAndInstall());
});

function startServer() {
  // ELECTRON_RUN_AS_NODE makes the Electron binary behave like plain Node.
  // Packaged builds run the prebuilt, dependency-free dist/server.mjs (fast start,
  // no tsx shipped); dev runs the TS entry through tsx directly.
  // SITEDECK_NO_OPEN stops the server from also launching a system browser.
  const entry = app.isPackaged
    ? [path.join(ROOT, 'dist', 'server.mjs')]
    : ['--import', 'tsx', path.join(ROOT, 'src', 'server.ts')];
  serverProc = spawn(process.execPath, entry, {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SITEDECK_NO_OPEN: '1' },
    // Pipe stdout so we can learn the real port; the server may fall back from
    // PORT if it's already taken. stderr is inherited so errors stay visible.
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  let buf = '';
  serverProc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text); // keep the server's log visible
    if (serverPort !== null) return;
    buf += text;
    const m = buf.match(/SITEDECK_LISTENING (\d+)/);
    if (m) {
      serverPort = Number(m[1]);
      onServerListening();
    }
  });

  serverProc.on('error', (err) => {
    console.error('SiteDeck server failed to start:', err);
    showServerError(`The local server could not be started: ${err.message}`);
  });
  serverProc.on('exit', (code, signal) => {
    if (!windowOpened) {
      showServerError(
        `The local server exited before it was ready (code ${code}${signal ? `, ${signal}` : ''}).`,
      );
    }
  });

  // Backstop: if the server neither announces a port nor exits, don't hang on a
  // blank window forever.
  setTimeout(() => {
    if (!windowOpened && serverPort === null) {
      showServerError('The local server did not start in time.');
    }
  }, 30000);
}

function onServerListening() {
  const base = `http://localhost:${serverPort}`;
  waitForServer(
    base,
    () => createWindow(base),
    () => showServerError('The local server started but did not respond in time.'),
  );
}

function waitForServer(base, onReady, onFail, tries = 0) {
  const req = http.get(base, (res) => {
    res.resume();
    onReady();
  });
  req.on('error', () => {
    if (tries < 75) setTimeout(() => waitForServer(base, onReady, onFail, tries + 1), 200);
    else onFail();
  });
}

// Startup path: show the main window exactly once (the windowOpened guard also
// blocks a late error window from racing in after the page already loaded).
function createWindow(base) {
  if (windowOpened) return;
  windowOpened = true;
  buildMainWindow(base);
}

function buildMainWindow(base) {
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
    openExternalSafely(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return;
    }
    // Only intercept http(s) navigations (external sites / our OAuth path). Other
    // schemes — e.g. a blob: CSV download — pass through untouched.
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return;
    if (target.host !== `localhost:${serverPort}` || target.pathname.startsWith('/oauth')) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });

  win.loadURL(base || `http://localhost:${serverPort}`);
}

// Replace the silent black screen with a readable error when the server can't start.
function showServerError(message) {
  if (windowOpened) return;
  windowOpened = true;
  const win = new BrowserWindow({
    width: 760,
    height: 460,
    title: 'SiteDeck',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
  });
  mainWindow = win;
  win.on('closed', () => {
    mainWindow = null;
  });
  const html =
    `<!doctype html><meta charset="utf-8">` +
    `<body style="font-family:Segoe UI,system-ui,sans-serif;background:#0d1117;color:#e6edf3;padding:48px;line-height:1.6">` +
    `<h2 style="color:#f85149;margin:0 0 12px">SiteDeck couldn't start</h2>` +
    `<p>${message}</p>` +
    `<p style="color:#8b949e">The local port may be in use by another app — for example another SiteDeck window, ` +
    `or Google Drive, which uses nearby ports. Close other instances and reopen SiteDeck.</p>` +
    `</body>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
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
    // startServer() reads the server's announced port from stdout and then opens
    // the window (or an error window if the server can't start).
    startServer();
    // Auto-update from GitHub Releases. Wire the event forwarding always so the
    // Settings tab's "Check for updates" works; only auto-check on packaged builds.
    wireAutoUpdater();
    if (app.isPackaged) {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('update check failed:', err);
      });
    }
    app.on('activate', () => {
      if (serverPort !== null && BrowserWindow.getAllWindows().length === 0) {
        buildMainWindow(`http://localhost:${serverPort}`);
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (serverProc) serverProc.kill();
});
