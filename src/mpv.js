'use strict';
// mpv controller: embeds mpv into a window HWND via --wid, controls it over a
// named pipe (JSON IPC). Windows-focused but pipe path is configurable.

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PIPE = '\\\\.\\pipe\\iptv-xstream-mpv';

function locateMpv(extraDirs = []) {
  const candidates = [];
  for (const d of extraDirs) candidates.push(path.join(d, 'mpv.exe'), path.join(d, 'mpv'));
  // PATH lookup
  const which = process.platform === 'win32'
    ? spawnSync('where', ['mpv'], { encoding: 'utf8' })
    : spawnSync('which', ['mpv'], { encoding: 'utf8' });
  if (which.status === 0) {
    const first = which.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (first) candidates.push(first);
  }
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

class Mpv {
  constructor() {
    this.proc = null;
    this.sock = null;
    this.reqId = 1;
    this.pending = new Map();
    this.onEvent = () => {};
    this.onLog = (s) => console.log('[mpv]', s);
    this.buf = '';
    this.pendingLoad = null;   // URL to load once IPC is connected
  }

  isRunning() { return !!this.proc && this.proc.exitCode === null; }

  start(mpvPath, wid) {
    if (this.isRunning()) return;
    const args = [
      `--wid=${wid}`,
      `--input-ipc-server=${PIPE}`,
      '--idle=yes',
      '--no-osc',
      '--no-window-dragging',
      '--auto-window-resize=no',   // never resize the embed window to video size (would overflow the pane)
      '--no-input-default-bindings',
      '--input-vo-keyboard=no',   // don't let mpv's window swallow keys
      '--no-input-cursor',        // mouse handled by app, not mpv
      '--cursor-autohide=no',
      '--keep-open=no',
      '--hwdec=auto-safe',
      '--volume=50',
      '--cache=yes',
      '--demuxer-max-bytes=64MiB',
      '--user-agent=MNZ-IPTV/1.0',
    ];
    this.onLog('spawn ' + mpvPath + ' wid=' + wid);
    this.proc = spawn(mpvPath, args, { windowsHide: false });
    if (this.proc.stderr) this.proc.stderr.on('data', d => this.onLog('ERR ' + d.toString().trim()));
    if (this.proc.stdout) this.proc.stdout.on('data', d => {
      const s = d.toString().trim();
      if (!/^AV:|^A:|\(Paused\)/.test(s)) this.onLog('OUT ' + s); // skip status spam
    });
    this.proc.on('error', e => this.onLog('proc error ' + e.message));
    this.proc.on('exit', (code) => { this.onLog('exit ' + code); this.proc = null; this._closeSock(); });
    // connect to pipe (retry until ready)
    this._connectLoop(0);
  }

  _connectLoop(tries) {
    if (!this.proc) return;
    const s = net.connect(PIPE);
    s.on('connect', () => {
      this.onLog('ipc connected (try ' + tries + ')');
      this.sock = s;
      s.on('data', (d) => this._onData(d));
      s.on('error', () => {});
      s.on('close', () => { this.sock = null; });
      // enable property events we care about
      this.observe('pause');
      this.observe('time-pos');
      this.observe('duration');
      this.observe('volume');
      this.observe('track-list');   // audio/subtitle tracks for language menus
      this.observe('aid');
      this.observe('sid');
      // playback stats (info panel)
      this.observe('width'); this.observe('height');
      this.observe('container-fps'); this.observe('estimated-vf-fps');
      this.observe('video-bitrate'); this.observe('audio-bitrate');
      this.observe('video-codec'); this.observe('audio-codec-name');
      this.observe('hwdec-current');
      // flush any URL requested before the pipe was ready
      if (this.pendingLoad) { const u = this.pendingLoad; this.pendingLoad = null; this._doLoad(u); }
    });
    s.on('error', () => {
      if (tries < 100 && this.proc) setTimeout(() => this._connectLoop(tries + 1), 100);
      else this.onLog('ipc connect gave up');
    });
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.request_id && this.pending.has(msg.request_id)) {
        const { resolve } = this.pending.get(msg.request_id);
        this.pending.delete(msg.request_id);
        resolve(msg);
      } else if (msg.event) {
        if (msg.event === 'file-loaded' && this.seekAfterLoad != null) {
          const s = this.seekAfterLoad; this.seekAfterLoad = null;
          setTimeout(() => this.seek(s), 150);   // resume position once the file is ready
        }
        this.onEvent(msg);
      }
    }
  }

  _send(obj) {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new Error('mpv not connected'));
      const id = this.reqId++;
      obj.request_id = id;
      this.pending.set(id, { resolve, reject });
      try { this.sock.write(JSON.stringify(obj) + '\n'); }
      catch (e) { this.pending.delete(id); reject(e); }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('mpv timeout')); }
      }, 5000);
    });
  }

  // Response-tracked send (for get_property / one-shot commands we log).
  command(...args) { return this._send({ command: args }); }
  getProp(name) { return this._send({ command: ['get_property', name] }); }
  observe(name) { return this._send({ command: ['observe_property', this.reqId, name] }).catch(() => {}); }

  // Fire-and-forget: no request_id, no pending entry, no 5s timeout. Used for
  // high-frequency controls (volume/seek) so dragging can't flood the pending
  // queue and stall the pipe.
  _fire(obj) {
    if (!this.sock) return;
    try { this.sock.write(JSON.stringify(obj) + '\n'); } catch {}
  }

  loadUrl(url, start) {
    this.seekAfterLoad = (start && start > 1) ? Math.floor(start) : null;  // resume point
    if (this.sock) return this._doLoad(url);
    this.onLog('queue load (ipc not ready): ' + url);
    this.pendingLoad = url;               // flushed on connect
    return Promise.resolve({ queued: true });
  }
  _doLoad(url) {
    this.onLog('loadfile ' + url);
    return this.command('loadfile', url, 'replace')
      .then(r => { this.onLog('loadfile ok'); return r; })
      .catch(e => { this.onLog('loadfile FAIL ' + e.message); throw e; });
  }
  stop() { this._fire({ command: ['stop'] }); return Promise.resolve(); }
  togglePause() { this._fire({ command: ['cycle', 'pause'] }); return Promise.resolve(); }
  setPause(v) { this._fire({ command: ['set_property', 'pause', !!v] }); return Promise.resolve(); }
  setVolume(v) { this._fire({ command: ['set_property', 'volume', Math.max(0, Math.min(100, v))] }); return Promise.resolve(); }
  seek(sec) { this._fire({ command: ['seek', sec, 'absolute'] }); return Promise.resolve(); }
  seekRel(sec) { this._fire({ command: ['seek', sec, 'relative'] }); return Promise.resolve(); }
  setAudioTrack(id) { this._fire({ command: ['set_property', 'aid', id] }); return Promise.resolve(); }   // id or 'no'
  setSubTrack(id) { this._fire({ command: ['set_property', 'sid', id] }); return Promise.resolve(); }

  _closeSock() { if (this.sock) { try { this.sock.destroy(); } catch {} this.sock = null; } }

  quit() {
    try { this.command('quit'); } catch {}
    this._closeSock();
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
  }
}

module.exports = { Mpv, locateMpv, PIPE };
