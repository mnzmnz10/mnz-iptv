'use strict';
const { app, BrowserWindow, ipcMain, shell, screen, Menu, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Xtream } = require('./xtream');
const { Mpv, locateMpv } = require('./mpv');

// mpv embeds via --wid into a child window HWND. Chromium's GPU compositor
// otherwise paints over that HWND (audio plays, video hidden). Disabling GPU
// compositing lets the embedded mpv surface show through.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-compositing');

// Pin the data dir to a fixed name so saved accounts survive app renames
// (Electron otherwise moves userData when the product name changes).
app.setPath('userData', path.join(app.getPath('appData'), 'iptv-xstream'));

let mainWin = null;
let videoWin = null;
let barWin = null;
let closeWin = null;
let xt = null;
const mpv = new Mpv();

// Minimal Turkish menu; only functional roles kept. Bar stays hidden (also in
// fullscreen); shortcuts still work, Alt reveals it if needed.
function buildMenu() {
  const template = [
    { label: 'Dosya', submenu: [
      { label: 'Çıkış', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
    ] },
    { label: 'Düzen', submenu: [
      { label: 'Geri Al', role: 'undo' }, { label: 'Yinele', role: 'redo' },
      { type: 'separator' },
      { label: 'Kes', role: 'cut' }, { label: 'Kopyala', role: 'copy' },
      { label: 'Yapıştır', role: 'paste' }, { label: 'Tümünü Seç', role: 'selectAll' },
    ] },
    { label: 'Görünüm', submenu: [
      { label: 'Yenile', accelerator: 'CmdOrCtrl+R', role: 'reload' },
      { label: 'Geliştirici Araçları', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindows() {
  mainWin = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 560,
    backgroundColor: '#0d1117',
    title: 'MNZ IPTV',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.webContents.on('console-message', (_e, level, message, line, src) => {
    console.log(`[renderer] ${message} (${src}:${line})`);
  });
  mainWin.webContents.on('preload-error', (_e, p, err) => console.error('[preload-error]', p, err));
  if (process.env.IPTV_DEBUG) mainWin.webContents.openDevTools({ mode: 'detach' });

  // Child frameless window hosting the embedded mpv video surface. Child of
  // mainWin so z-order and focus follow the parent (independent + alwaysOnTop
  // kept it above OTHER apps and stole focus). focusable:false so keys reach
  // the main renderer instead of mpv.
  videoWin = new BrowserWindow({
    parent: mainWin, frame: false, transparent: false,
    backgroundColor: '#000000', show: false, resizable: false,
    skipTaskbar: true, focusable: false,
    webPreferences: { contextIsolation: true },
  });
  videoWin.setIgnoreMouseEvents(false);
  videoWin.loadURL('data:text/html,<body style="margin:0;background:#000"></body>');
  // mpv can autofit its embed window to the video's size; snap it back to the pane.
  videoWin.on('resize', () => {
    if (applyingBounds || !lastVideoBounds) return;
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => {
      if (videoWin && !videoWin.isDestroyed() && lastVideoBounds) {
        applyingBounds = true;
        videoWin.setBounds(lastVideoBounds);
        setTimeout(() => { applyingBounds = false; }, 60);
      }
    }, 40);
  });

  // Overlay control bar: transparent child, shown above the video in fullscreen.
  // focusable:false so clicking it does NOT steal focus from mainWin (which
  // would drop Windows fullscreen). Clicks/drags still reach the buttons.
  barWin = new BrowserWindow({
    parent: mainWin, frame: false, transparent: true, show: false,
    resizable: false, skipTaskbar: true, hasShadow: false, focusable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  barWin.loadFile(path.join(__dirname, 'bar.html'));
  barWin.webContents.on('console-message', (_e, l, m, ln) => console.log('[bar-win] ' + m + ' (:' + ln + ')'));

  // Small transparent close (X) overlay pinned to the video's top-right corner.
  closeWin = new BrowserWindow({
    parent: mainWin, frame: false, transparent: true, show: false,
    resizable: false, skipTaskbar: true, hasShadow: false, focusable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  closeWin.setAlwaysOnTop(true, 'screen-saver');
  closeWin.loadFile(path.join(__dirname, 'close.html'));

  const reqBounds = () => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('request-video-bounds'); };
  for (const ev of ['move', 'resize', 'restore', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'])
    mainWin.on(ev, reqBounds);
  // If fullscreen drops for any reason, keep our state/bar in sync.
  mainWin.on('leave-full-screen', () => { if (fsActive) doSetFs(false); });

  mainWin.on('closed', () => { mainWin = null; mpv.quit(); for (const w of [videoWin, barWin, closeWin]) if (w && !w.isDestroyed()) w.destroy(); });
  mainWin.on('close', () => { mpv.quit(); });

  // Forward mpv property events to both windows (time, pause, duration, volume).
  mpv.onEvent = (msg) => {
    if (msg.event !== 'property-change') return;
    const payload = { name: msg.name, data: msg.data };
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('mpv-event', payload);
    if (barWin && !barWin.isDestroyed()) barWin.webContents.send('mpv-event', payload);
  };
}

app.whenReady().then(() => {
  imgDir = path.join(app.getPath('userData'), 'imgcache');
  try { fs.mkdirSync(imgDir, { recursive: true }); } catch {}
  setTimeout(() => pruneImgCache(350 * 1024 * 1024), 4000); // background prune after startup
  buildMenu(); createWindows();
  setTimeout(setupAutoUpdate, 3000);   // check for updates shortly after launch
});

// ---- Auto-update (GitHub Releases via electron-updater) ----
function setupAutoUpdate() {
  if (!app.isPackaged) return;   // only in the installed build
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;   // if user picks "Sonra", install silently on next quit
  const send = (ch, payload) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, payload); };
  autoUpdater.on('update-available', (i) => send('update-status', { phase: 'available', version: i && i.version }));
  autoUpdater.on('update-not-available', () => send('update-status', { phase: 'none' }));
  autoUpdater.on('download-progress', (p) => send('update-progress', { percent: p.percent || 0, bps: p.bytesPerSecond || 0 }));
  autoUpdater.on('update-downloaded', async (i) => {
    send('update-status', { phase: 'ready', version: i && i.version });
    const { response } = await dialog.showMessageBox(mainWin, {
      type: 'info', buttons: ['Şimdi kur ve yeniden başlat', 'Sonra'], defaultId: 0, cancelId: 1,
      title: 'Güncelleme hazır',
      message: 'Yeni sürüm indirildi' + (i && i.version ? ' (' + i.version + ')' : '') + '.',
      detail: 'Kurulum arka planda sessizce yapılacak; kurulum sihirbazı açılmaz.',
    });
    // isSilent=true -> no NSIS setup window; isForceRunAfter=true -> relaunch app after install
    if (response === 0) autoUpdater.quitAndInstall(true, true);
  });
  autoUpdater.on('error', (e) => { send('update-status', { phase: 'error' }); console.log('[update] error', e && e.message); });
  autoUpdater.checkForUpdates().catch((e) => console.log('[update] check failed', e && e.message));
}
app.on('window-all-closed', () => { mpv.quit(); if (process.platform !== 'darwin') app.quit(); });

// ---- IPC: Xtream API ----
ipcMain.handle('xt-login', async (_e, creds) => {
  xt = new Xtream(creds);
  const info = await xt.login();
  if (!info || !info.user_info || info.user_info.auth === 0)
    throw new Error('Login failed: check server/username/password.');
  return info;
});

const apiCall = (fn) => async (_e, ...args) => { if (!xt) throw new Error('Not logged in'); return fn(...args); };
ipcMain.handle('xt-live-cats',   apiCall((...a) => xt.getLiveCategories(...a)));
ipcMain.handle('xt-vod-cats',    apiCall((...a) => xt.getVodCategories(...a)));
ipcMain.handle('xt-series-cats', apiCall((...a) => xt.getSeriesCategories(...a)));
ipcMain.handle('xt-live',        apiCall((...a) => xt.getLiveStreams(...a)));
ipcMain.handle('xt-vod',         apiCall((...a) => xt.getVodStreams(...a)));
ipcMain.handle('xt-series',      apiCall((...a) => xt.getSeries(...a)));
ipcMain.handle('xt-vod-info',    apiCall((...a) => xt.getVodInfo(...a)));
ipcMain.handle('xt-series-info', apiCall((...a) => xt.getSeriesInfo(...a)));
ipcMain.handle('xt-epg',         apiCall((...a) => xt.getShortEpg(...a)));
ipcMain.handle('xt-url', (_e, kind, id, ext) => {
  if (!xt) throw new Error('Not logged in');
  if (kind === 'live')   return xt.liveUrl(id, ext || 'ts');
  if (kind === 'movie')  return xt.movieUrl(id, ext);
  if (kind === 'series') return xt.seriesUrl(id, ext);
  throw new Error('bad kind');
});

// ---- IPC: player ----
function ensureMpv() {
  if (mpv.isRunning()) return { ok: true };
  const dirs = [
    path.join(process.resourcesPath || '', 'bin'),
    path.join(app.getAppPath(), 'bin'),
    path.join(__dirname, '..', 'bin'),
  ];
  const bin = locateMpv(dirs);
  if (!bin) { console.log('[mpv] not found in', dirs); return { ok: false, error: 'mpv-not-found' }; }
  console.log('[mpv] using', bin);
  const handle = videoWin.getNativeWindowHandle();
  const wid = process.platform === 'win32'
    ? handle.readBigUInt64LE(0).toString()
    : handle.readBigUInt64LE ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
  mpv.start(bin, wid);
  return { ok: true };
}

ipcMain.handle('player-play', async (_e, url, start) => {
  console.log('[play] request', url, start ? '@' + start : '');
  const r = ensureMpv();
  if (!r.ok) { console.log('[play] ensureMpv failed', r); return r; }
  if (videoWin && !videoWin.isDestroyed()) videoWin.showInactive();
  await mpv.loadUrl(url, start).catch(e => console.log('[play] loadUrl err', e.message)); // queues if ipc not ready
  return { ok: true };
});
ipcMain.handle('player-pause',   () => mpv.togglePause().catch(() => {}));
ipcMain.handle('player-stop',    () => { mpv.stop().catch(() => {}); if (videoWin && !videoWin.isDestroyed()) videoWin.hide(); });
ipcMain.handle('player-volume',  (_e, v) => mpv.setVolume(v).catch(() => {}));
ipcMain.handle('player-seek',    (_e, s) => mpv.seek(s).catch(() => {}));
ipcMain.handle('player-seekrel', (_e, s) => mpv.seekRel(s).catch(() => {}));
ipcMain.handle('player-audio',   (_e, id) => mpv.setAudioTrack(id).catch(() => {}));
ipcMain.handle('player-sub',     (_e, id) => mpv.setSubTrack(id).catch(() => {}));

ipcMain.on('video-bounds', (_e, rect) => {
  if (!videoWin || videoWin.isDestroyed() || !mainWin || mainWin.isDestroyed()) return;
  if (!rect || rect.w <= 0 || rect.h <= 0) { videoWin.hide(); if (closeWin && !closeWin.isDestroyed()) closeWin.hide(); return; }
  const cb = mainWin.getContentBounds();
  const nb = {
    x: Math.round(cb.x + rect.x), y: Math.round(cb.y + rect.y),
    width: Math.round(rect.w), height: Math.round(rect.h),
  };
  lastVideoBounds = nb;
  applyingBounds = true;
  videoWin.setBounds(nb);
  setTimeout(() => { applyingBounds = false; }, 60);
  // pin the close (X) overlay to the video's top-right corner
  if (closeWin && !closeWin.isDestroyed()) {
    closeWin.setBounds({ x: nb.x + nb.width - 52, y: nb.y + 6, width: 48, height: 48 });
    if (!closeWin.isVisible()) closeWin.showInactive();
  }
});
let lastVideoBounds = null, applyingBounds = false, refitTimer = null;
ipcMain.on('video-visible', (_e, vis) => {
  if (videoWin && !videoWin.isDestroyed()) { if (vis) videoWin.showInactive(); else videoWin.hide(); }
  if (closeWin && !closeWin.isDestroyed()) { if (vis) closeWin.showInactive(); else closeWin.hide(); }
});
// While fullscreen, mpv's window captures the mouse so the renderer never sees
// mousemove over the video. Poll the global cursor instead and forward activity.
let cursorTimer = null, lastPt = null, barHideTimer = null;
const BAR_H = 76;

function positionBar() {
  if (!barWin || barWin.isDestroyed() || !mainWin || mainWin.isDestroyed()) return;
  const cb = mainWin.getContentBounds();
  barWin.setBounds({ x: cb.x, y: cb.y + cb.height - BAR_H, width: cb.width, height: BAR_H });
}
function showBarWin() {
  if (!fsActive || !barWin || barWin.isDestroyed()) return;
  if (!barWin.isVisible()) { positionBar(); barWin.showInactive(); } // only reposition on first show, not every mousemove (breaks slider drags)
  clearTimeout(barHideTimer);
  barHideTimer = setTimeout(() => { if (barWin && !barWin.isDestroyed()) barWin.hide(); }, 2600);
}
function hideBarWin() {
  clearTimeout(barHideTimer);
  if (barWin && !barWin.isDestroyed()) barWin.hide();
}

function startCursorWatch() {
  if (cursorTimer) return;
  lastPt = null;
  cursorTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    if (lastPt && p.x === lastPt.x && p.y === lastPt.y) return;
    lastPt = p;
    if (!mainWin || mainWin.isDestroyed()) return;
    const b = mainWin.getBounds();          // only react inside our window (not 2nd monitor / outside)
    if (p.x < b.x || p.y < b.y || p.x >= b.x + b.width || p.y >= b.y + b.height) return;
    showBarWin();
  }, 120);
}
function stopCursorWatch() { if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null; } }

let fsActive = false;
function doSetFs(v) {
  fsActive = !!v;
  if (mainWin && !mainWin.isDestroyed()) mainWin.setFullScreen(fsActive);
  if (fsActive) { startCursorWatch(); showBarWin(); }
  else { stopCursorWatch(); hideBarWin(); }
  // Reset the child video window's implicit fullscreen state and re-fit bounds
  // after the parent's fullscreen toggle settles.
  if (videoWin && !videoWin.isDestroyed()) {
    if (videoWin.isFullScreen()) videoWin.setFullScreen(false);
    for (const d of [80, 250, 500])
      setTimeout(() => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('request-video-bounds'); }, d);
  }
  // main is authoritative: always sync renderer UI (applyFs is idempotent)
  if (mainWin && !mainWin.isDestroyed())
    mainWin.webContents.send('apply-fullscreen', fsActive);
}

// renderer-initiated (button / in-app key while UI focused): UI already updated
ipcMain.on('set-fullscreen', (_e, v) => doSetFs(v));
// Poster/logo proxy with a persistent DISK cache: fetch with a browser UA + no
// Referer (some CDNs 403 the renderer's request), store the data URL on disk so
// posters survive restarts. RAM map fronts the disk for speed.
const imgCache = new Map();
let imgDir = null;
function imgFile(url) { return path.join(imgDir, crypto.createHash('sha1').update(url).digest('hex')); }

ipcMain.handle('fetch-image', async (_e, url) => {
  if (!url || typeof url !== 'string' || !imgDir) return null;
  if (imgCache.has(url)) return imgCache.get(url);
  const file = imgFile(url);
  try {                                              // disk hit
    const data = await fs.promises.readFile(file, 'utf8');
    if (data) { imgCache.set(url, data); return data; }
  } catch {}
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' },
      redirect: 'follow', signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    let type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (/^text\//i.test(type)) return null;          // an HTML error page, not an image
    if (!/^image\//i.test(type)) type = 'image/jpeg'; // octet-stream etc. — assume image
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 6 * 1024 * 1024) return null;
    const data = `data:${type};base64,${buf.toString('base64')}`;
    if (imgCache.size > 1500) imgCache.clear();       // RAM cap only; disk keeps all
    imgCache.set(url, data);
    fs.promises.writeFile(file, data).catch(() => {}); // persist (async, non-blocking)
    return data;
  } catch { return null; }
});

// Keep the disk cache from growing without bound: prune oldest over ~350 MB.
async function pruneImgCache(maxBytes) {
  try {
    const files = await fs.promises.readdir(imgDir);
    const stats = [];
    for (const f of files) {
      try { const st = await fs.promises.stat(path.join(imgDir, f)); stats.push({ f, size: st.size, m: st.mtimeMs }); } catch {}
    }
    let total = stats.reduce((a, b) => a + b.size, 0);
    if (total <= maxBytes) return;
    stats.sort((a, b) => a.m - b.m);                 // oldest first
    for (const v of stats) { if (total <= maxBytes) break; await fs.promises.unlink(path.join(imgDir, v.f)).catch(() => {}); total -= v.size; }
  } catch {}
}

ipcMain.on('request-stop', () => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('do-stop'); });
ipcMain.on('bar-title', (_e, t) => { if (barWin && !barWin.isDestroyed()) barWin.webContents.send('bar-title', t); });
ipcMain.on('open-external', (_e, url) => shell.openExternal(url));
