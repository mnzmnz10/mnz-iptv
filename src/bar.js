'use strict';
// Overlay fullscreen control bar. Lives in its own window above the mpv video
// surface. Uses the same preload (window.api) as the main window.
(function () {
const $ = (id) => document.getElementById(id);
const api = window.api;
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

let duration = 0, curTime = 0, isVod = false;

$('pause').onclick = () => api.pause();
$('back').onclick = () => api.seekRel(-10);
$('fwd').onclick = () => api.seekRel(10);
$('exit').onclick = () => api.setFullscreen(false);
let volPending = null;
$('vol').oninput = () => {                 // throttle to ~1 command per frame
  if (volPending) return;
  volPending = requestAnimationFrame(() => { volPending = null; api.volume(+$('vol').value); });
};
$('seek').oninput = () => { if (duration > 0) api.seek((+$('seek').value / 1000) * duration); };

$('audioSel').onchange = () => api.setAudio($('audioSel').value);
$('subSel').onchange = () => api.setSub($('subSel').value);

api.onMpvEvent(({ name, data }) => {
  if (name === 'duration') { duration = data || 0; isVod = duration > 0; $('seek').disabled = !isVod; $('seek').style.opacity = isVod ? '1' : '.4'; }
  else if (name === 'time-pos') { curTime = data || 0; updateTime(); }
  else if (name === 'pause') $('pause').innerHTML = data ? ICON_PLAY : ICON_PAUSE;
  else if (name === 'volume' && data != null && document.activeElement !== $('vol'))
    $('vol').value = Math.round(data); // don't fight the user while dragging
  else if (name === 'track-list') fillTracks(data);
  else if (name === 'aid' && data != null) $('audioSel').value = String(data);
  else if (name === 'sid') $('subSel').value = data == null ? 'no' : String(data);
  else if (STAT_KEYS.includes(name)) { videoStats[name] = data; if (infoOpen) renderBarInfo(); }
});

const STAT_KEYS = ['width', 'height', 'container-fps', 'estimated-vf-fps', 'video-bitrate', 'audio-bitrate', 'video-codec', 'audio-codec-name', 'hwdec-current'];
let videoStats = {}, infoOpen = false;
function fmtBitrate(bps) { if (!bps) return null; return bps >= 1e6 ? (bps / 1e6).toFixed(2) + ' Mbps' : Math.round(bps / 1e3) + ' kbps'; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function statHtml(label, val) { return val ? `<span>${label}: <b>${esc(val)}</b></span>` : ''; }
function renderBarInfo() {
  const s = videoStats;
  const res = (s.width && s.height) ? `${s.width}×${s.height}` : null;
  const fps = s['estimated-vf-fps'] || s['container-fps'];
  const fpsTxt = fps ? (Math.round(fps * 100) / 100) + ' fps' : null;
  const html = [
    statHtml('Çözünürlük', res), statHtml('FPS', fpsTxt),
    statHtml('Video', s['video-codec']), statHtml('Video bitrate', fmtBitrate(s['video-bitrate'])),
    statHtml('Ses', s['audio-codec-name']), statHtml('Ses bitrate', fmtBitrate(s['audio-bitrate'])),
    statHtml('Donanım', s['hwdec-current'] && s['hwdec-current'] !== 'no' ? s['hwdec-current'] : null),
  ].filter(Boolean).join('');
  $('barInfo').innerHTML = html || '<span>Bilgi bekleniyor…</span>';
}
$('info').onclick = () => {
  infoOpen = !infoOpen;
  $('barInfo').classList.toggle('hidden', !infoOpen);
  $('info').classList.toggle('on', infoOpen);
  if (infoOpen) renderBarInfo();
};

function fillTracks(list) {
  list = Array.isArray(list) ? list : [];
  const audio = list.filter(t => t.type === 'audio');
  const subs = list.filter(t => t.type === 'sub');
  fillSel($('audioSel'), audio, false);
  fillSel($('subSel'), subs, true);
}
function fillSel(sel, tracks, withOff) {
  sel.innerHTML = '';
  if (withOff) sel.appendChild(opt('no', 'Altyazı: Kapalı'));
  for (const t of tracks) {
    const label = (sel.id === 'subSel' ? 'CC ' : '🔊 ') + trackLabel(t);
    const o = opt(String(t.id), label);
    if (t.selected) o.selected = true;
    sel.appendChild(o);
  }
  sel.classList.toggle('hidden', tracks.length === 0);
}
function trackLabel(t) {
  const parts = [];
  if (t.lang) parts.push(t.lang.toUpperCase());
  if (t.title) parts.push(t.title);
  return parts.join(' · ') || ('#' + t.id);
}
function opt(v, txt) { const o = document.createElement('option'); o.value = v; o.textContent = txt; return o; }
// current title pushed from main
api.onBarTitle((t) => { $('title').textContent = t || ''; });

function updateTime() {
  $('time').textContent = `${fmtTime(curTime)} / ${fmtTime(duration)}`;
  if (isVod && duration > 0 && document.activeElement !== $('seek'))
    $('seek').value = Math.round((curTime / duration) * 1000);
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
})();
