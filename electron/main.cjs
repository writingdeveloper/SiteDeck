const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.PORT ?? 4317);
const BASE_URL = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

let serverProc = null;

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
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
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

app.whenReady().then(() => {
  startServer();
  waitForServer(createWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (serverProc) serverProc.kill();
});
