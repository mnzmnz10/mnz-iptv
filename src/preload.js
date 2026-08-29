'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Xtream
  login: (creds) => ipcRenderer.invoke('xt-login', creds),
  liveCats: () => ipcRenderer.invoke('xt-live-cats'),
  vodCats: () => ipcRenderer.invoke('xt-vod-cats'),
  seriesCats: () => ipcRenderer.invoke('xt-series-cats'),
  live: (catId) => ipcRenderer.invoke('xt-live', catId),
  vod: (catId) => ipcRenderer.invoke('xt-vod', catId),
  series: (catId) => ipcRenderer.invoke('xt-series', catId),
  vodInfo: (id) => ipcRenderer.invoke('xt-vod-info', id),
  seriesInfo: (id) => ipcRenderer.invoke('xt-series-info', id),
  epg: (streamId, limit) => ipcRenderer.invoke('xt-epg', streamId, limit),
  url: (kind, id, ext) => ipcRenderer.invoke('xt-url', kind, id, ext),
  fetchImage: (u) => ipcRenderer.invoke('fetch-image', u),
  // Player
  play: (url, start) => ipcRenderer.invoke('player-play', url, start),
  pause: () => ipcRenderer.invoke('player-pause'),
  stop: () => ipcRenderer.invoke('player-stop'),
  volume: (v) => ipcRenderer.invoke('player-volume', v),
  seek: (s) => ipcRenderer.invoke('player-seek', s),
  seekRel: (s) => ipcRenderer.invoke('player-seekrel', s),
  setAudio: (id) => ipcRenderer.invoke('player-audio', id),
  setSub: (id) => ipcRenderer.invoke('player-sub', id),
  // Video surface bounds/visibility
  setVideoBounds: (rect) => ipcRenderer.send('video-bounds', rect),
  setVideoVisible: (v) => ipcRenderer.send('video-visible', v),
  onRequestBounds: (cb) => ipcRenderer.on('request-video-bounds', cb),
  onMpvEvent: (cb) => ipcRenderer.on('mpv-event', (_e, m) => cb(m)),
  setFullscreen: (v) => ipcRenderer.send('set-fullscreen', v),
  requestStop: () => ipcRenderer.send('request-stop'),
  onDoStop: (cb) => ipcRenderer.on('do-stop', cb),
  onCursorActivity: (cb) => ipcRenderer.on('cursor-activity', cb),
  onApplyFullscreen: (cb) => ipcRenderer.on('apply-fullscreen', (_e, v) => cb(v)),
  onBarTitle: (cb) => ipcRenderer.on('bar-title', (_e, t) => cb(t)),
  setBarTitle: (t) => ipcRenderer.send('bar-title', t),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onAppToast: (cb) => ipcRenderer.on('app-toast', (_e, m) => cb(m)),
  // Auto-update
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, p) => cb(p)),
});
