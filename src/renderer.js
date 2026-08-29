'use strict';
(function () {
const $ = (id) => document.getElementById(id);
const api = window.api;
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

// Surface any early failure so a dead button is never silent.
window.addEventListener('error', (e) => {
  const box = document.getElementById('loginErr');
  if (box) box.textContent = 'JS hata: ' + (e.message || e.error);
  console.error('renderer error', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  const box = document.getElementById('loginErr');
  if (box) box.textContent = 'Promise hata: ' + (e.reason && (e.reason.message || e.reason));
});
if (!api) {
  const box = document.getElementById('loginErr');
  if (box) box.textContent = 'preload yüklenmedi (window.api yok)';
}

let tab = 'live';          // live | movie | series
let cats = [];             // current categories
let items = [];            // current stream/movie/series list
let activeCatId = null;
let isVod = false;         // seekable content (movie/episode)
let duration = 0, curTime = 0, paused = false;
let curPlaying = null;     // what's playing now, for resume/progress
let lastSave = 0;

// ---------- Watch history (resume) ----------
function getWatch() { try { return JSON.parse(localStorage.getItem('watch') || '{}'); } catch { return {}; } }
function saveWatch(w) { try { localStorage.setItem('watch', JSON.stringify(w)); } catch {} }
function writeWatch() {
  if (!curPlaying || !isVod || !duration || curTime < 5) return;
  const w = getWatch();
  const done = duration > 0 && curTime / duration > 0.95;   // finished -> reset to start
  w[curPlaying.key] = { ...curPlaying, position: done ? 0 : curTime, duration, updatedAt: Date.now() };
  const keys = Object.keys(w).sort((a, b) => w[b].updatedAt - w[a].updatedAt);
  for (const k of keys.slice(60)) delete w[k];            // keep last 60
  saveWatch(w);
}
function watchFor(t) { return Object.values(getWatch()).filter(e => e.tab === t).sort((a, b) => b.updatedAt - a.updatedAt); }
function maybeSaveProgress() {
  const now = Date.now();
  if (now - lastSave < 5000) return;
  lastSave = now; writeWatch();
}

// ---------- Favorites ----------
function getFavs() { try { return JSON.parse(localStorage.getItem('favs') || '{}'); } catch { return {}; } }
function saveFavs(f) { try { localStorage.setItem('favs', JSON.stringify(f)); } catch {} }
function favKeyOf(x) {
  if (tab === 'series') return 'series:' + x.series_id;
  if (tab === 'live')   return 'live:' + x.stream_id;
  return 'movie:' + x.stream_id;
}
function isFav(x) { return !!getFavs()[favKeyOf(x)]; }
function toggleFav(x) {
  const f = getFavs(), k = favKeyOf(x);
  if (f[k]) delete f[k];
  else f[k] = { key: k, tab, item: { ...x, name: x.name || x.title, poster: posterOf(x) }, addedAt: Date.now() };
  saveFavs(f);
}
function favFor(t) { return Object.values(getFavs()).filter(e => e.tab === t).sort((a, b) => b.addedAt - a.addedAt); }

// ---------- "Tümü" cache (global search + recently added) ----------
const allCache = {};   // tab -> full item list
async function fetchAll() {
  if (allCache[tab]) return allCache[tab];
  const data = await (tab === 'live' ? api.live(null) : tab === 'movie' ? api.vod(null) : api.series(null));
  allCache[tab] = Array.isArray(data) ? data : [];
  return allCache[tab];
}

// ---------- Accounts (multiple, saved locally) ----------
function getAccounts() { try { return JSON.parse(localStorage.getItem('accounts') || '[]'); } catch { return []; } }
function saveAccounts(a) { localStorage.setItem('accounts', JSON.stringify(a)); }
let editingId = null;

const AVATAR_COLORS = ['#16a34a', '#0ea5e9', '#8b5cf6', '#f59e0b', '#ec4899', '#ef4444', '#14b8a6', '#f97316'];
function avatarColor(a) {
  const s = (a.id || a.username || a.name || '');
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function showPick() { $('pickMode').classList.remove('hidden'); $('formMode').classList.add('hidden'); renderGrid(); }
function showForm() { $('pickMode').classList.add('hidden'); $('formMode').classList.remove('hidden'); }

function renderGrid() {
  const box = $('accountGrid');
  box.innerHTML = '';
  for (const a of getAccounts()) {
    const p = document.createElement('div'); p.className = 'profile';
    const av = div('pav', (a.name || a.username || '?').trim().charAt(0).toUpperCase());
    av.style.background = avatarColor(a);
    p.appendChild(av);
    p.appendChild(div('pnm', a.name || a.username));
    const acts = document.createElement('div'); acts.className = 'pactions';
    const edit = document.createElement('button'); edit.textContent = '✎'; edit.title = 'Düzenle';
    edit.onclick = (e) => { e.stopPropagation(); startEdit(a); };
    const del = document.createElement('button'); del.textContent = '🗑'; del.title = 'Sil';
    del.onclick = (e) => { e.stopPropagation(); if (confirm(`"${a.name || a.username}" hesabını sil?`)) removeAccount(a.id); };
    acts.append(edit, del); p.appendChild(acts);
    p.onclick = () => tryLogin(a);
    box.appendChild(p);
  }
  const add = document.createElement('div'); add.className = 'profile add';
  add.appendChild(div('pav', '+')); add.appendChild(div('pnm', 'Hesap ekle'));
  add.onclick = () => { resetForm(); showForm(); $('accName').focus(); };
  box.appendChild(add);
}
function fillForm(a) {
  $('accName').value = (a && a.name) || ''; $('server').value = (a && a.server) || '';
  $('username').value = (a && a.username) || ''; $('password').value = (a && a.password) || '';
}
function startEdit(a) {
  editingId = a.id; fillForm(a);
  $('formTitle').textContent = 'Hesabı düzenle'; $('loginBtn').textContent = 'Güncelle & Giriş';
  showForm(); $('accName').focus();
}
function resetForm() {
  editingId = null; fillForm(null);
  $('formTitle').textContent = 'Yeni hesap'; $('loginBtn').textContent = 'Kaydet & Giriş';
  $('loginErr').textContent = '';
}
function removeAccount(id) { saveAccounts(getAccounts().filter(a => a.id !== id)); if (editingId === id) resetForm(); renderGrid(); }
function upsertAccount(acc) {
  const list = getAccounts();
  if (editingId) { const i = list.findIndex(a => a.id === editingId); if (i >= 0) list[i] = { ...acc, id: editingId }; }
  else { acc.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); list.push(acc); }
  saveAccounts(list);
}
$('backToPick').onclick = () => showPick();
// start on picker if there are saved accounts, else straight to the add form
if (getAccounts().length) showPick(); else { renderGrid(); showForm(); }

$('loginBtn').onclick = () => submitForm();
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitForm(); });

async function submitForm() {
  const acc = { name: $('accName').value.trim(), server: $('server').value.trim(), username: $('username').value.trim(), password: $('password').value };
  $('loginErr').textContent = '';
  if (!acc.server || !acc.username) { $('loginErr').textContent = 'Sunucu ve kullanıcı gerekli.'; return; }
  if (!acc.name) acc.name = acc.username;
  const ok = await tryLogin(acc);
  if (ok) { upsertAccount(acc); resetForm(); renderGrid(); }
}

async function tryLogin(creds) {
  $('loginErr').textContent = '';
  $('loginBtn').disabled = true; const prev = $('loginBtn').textContent; $('loginBtn').textContent = 'Bağlanıyor…';
  try {
    const info = await api.login(creds);
    const u = info.user_info || {};
    $('acct').textContent = `${creds.name || u.username || ''} · ${u.status || ''}${u.exp_date ? ' · bitiş ' + fmtDate(u.exp_date) : ''}`;
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    selectTab('live');
    initAuto();
    return true;
  } catch (e) {
    $('loginErr').textContent = String(e.message || e);
    return false;
  } finally {
    $('loginBtn').disabled = false; $('loginBtn').textContent = prev;
  }
}

$('logoutBtn').onclick = () => { api.stop(); location.reload(); };

// ---------- Refresh (manual + auto) ----------
let refreshing = false, autoTimer = null;
async function refreshList(silent) {
  if (refreshing || $('login').classList.contains('hidden') === false) return; // only after login
  refreshing = true;
  $('btnRefresh').classList.add('spin');
  try {
    const fresh = await (tab === 'live' ? api.liveCats() : tab === 'movie' ? api.vodCats() : api.seriesCats());
    cats = Array.isArray(fresh) ? fresh : [];
    delete allCache[tab];                       // force "Tümü"/"Yeni eklenenler" to refetch
    renderCats();
    if (VCAT_LOADERS[activeCatId]) {            // virtual category active
      const before = items.length;
      await VCAT_LOADERS[activeCatId]();
      const added = items.length - before;
      if (added > 0) toast(`${added} yeni içerik eklendi`);
      else if (!silent) toast('Liste güncel');
    } else if (activeCatId) {
      const before = items.length;
      await loadItems(activeCatId);
      const added = items.length - before;
      if (added > 0) toast(`${added} yeni içerik eklendi`);
      else if (!silent) toast('Liste güncel');
    } else if (!silent) toast('Liste güncel');
  } catch (e) {
    if (!silent) toast('Yenileme başarısız');
  } finally {
    refreshing = false; $('btnRefresh').classList.remove('spin');
  }
}
$('btnRefresh').onclick = () => refreshList(false);

function applyAuto(on) {
  clearInterval(autoTimer); autoTimer = null;
  if (on) autoTimer = setInterval(() => refreshList(true), 10 * 60 * 1000); // every 10 min, silent
}
$('autoRefresh').onchange = () => {
  const on = $('autoRefresh').checked;
  localStorage.setItem('autoRefresh', on ? '1' : '0');
  applyAuto(on);
  toast(on ? 'Oto-yenileme açık (10 dk)' : 'Oto-yenileme kapalı');
};
function initAuto() {
  const on = localStorage.getItem('autoRefresh') === '1';
  $('autoRefresh').checked = on;
  applyAuto(on);
}

api.onAppToast((m) => toast(m));   // update progress / status from main
let toastT = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 300); }, 2600);
}

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach(b => b.onclick = () => selectTab(b.dataset.tab));
async function selectTab(t) {
  tab = t;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  $('listTitle').textContent = t === 'live' ? 'Kanallar' : t === 'movie' ? 'Filmler' : 'Diziler';
  $('list').innerHTML = ''; items = []; activeCatId = null;
  await loadCats();
}

async function loadCats() {
  $('cats').innerHTML = '<div class="item">Yükleniyor…</div>';
  try {
    cats = await (tab === 'live' ? api.liveCats() : tab === 'movie' ? api.vodCats() : api.seriesCats());
    if (!Array.isArray(cats)) cats = [];
    renderCats();
    if (!activeCatId && cats.length) {      // auto-open first category so cards show immediately
      activeCatId = cats[0].category_id;
      renderCats();
      loadItems(activeCatId);
    }
  } catch (e) { $('cats').innerHTML = `<div class="item">Hata: ${esc(e.message)}</div>`; }
}

// Virtual categories: id -> loader. Rendered above the real category list.
const VCAT_LOADERS = { __fav__: loadFav, __all__: loadAll, __recent__: loadRecent, __resume__: loadResume };
function addVCat(id, label, cls) {
  const r = div('item ' + (cls || ''), label);
  r.dataset.id = id;
  if (activeCatId === id) r.classList.add('active');
  r.onclick = () => { activeCatId = id; renderCats(); VCAT_LOADERS[id](); };
  $('cats').appendChild(r);
}
function renderCats() {
  const q = $('catSearch').value.toLowerCase();
  const list = cats.filter(c => !q || (c.category_name || '').toLowerCase().includes(q));
  $('cats').innerHTML = '';
  if (!q) {
    if (favFor(tab).length) addVCat('__fav__', '⭐ Favoriler', 'fav-cat');
    addVCat('__all__', '🔍 Tümü (ara)', 'all-cat');
    if (tab === 'movie' || tab === 'series') {
      addVCat('__recent__', '🆕 Yeni eklenenler', 'recent-cat');
      if (watchFor(tab).length) addVCat('__resume__', '▶ İzlemeye devam et', 'resume-cat');
    }
  }
  for (const c of list) {
    const d = div('item', c.category_name || '(isimsiz)');
    d.dataset.id = c.category_id;
    if (c.category_id === activeCatId) d.classList.add('active');
    d.onclick = () => { activeCatId = c.category_id; renderCats(); loadItems(c.category_id); };
    $('cats').appendChild(d);
  }
}
$('catSearch').oninput = renderCats;

async function loadItems(catId) {
  $('listTitle').textContent = tab === 'live' ? 'Kanallar' : tab === 'movie' ? 'Filmler' : 'Diziler';
  $('list').innerHTML = '<div class="item">Yükleniyor…</div>';
  try {
    items = await (tab === 'live' ? api.live(catId) : tab === 'movie' ? api.vod(catId) : api.series(catId));
    if (!Array.isArray(items)) items = [];
    renderItems();
  } catch (e) { $('list').innerHTML = `<div class="item">Hata: ${esc(e.message)}</div>`; }
}

function posterOf(x) {
  return x.stream_icon || x.cover || x.cover_big || (x.info && x.info.movie_image) || '';
}
function posterFallback(img) {
  const thumb = img.parentElement;
  if (thumb) { img.remove(); thumb.textContent = thumb.dataset.icon || '🎬'; }
}
function renderItems() {
  const q = $('itemSearch').value.toLowerCase();
  const list = items.filter(x => !q || ((x.name || x.title || '') + '').toLowerCase().includes(q));
  const el = $('list');
  el.classList.add('cards');
  el.innerHTML = '';
  for (const x of list) {
    const title = x.name || x.title || '(isimsiz)';
    const card = document.createElement('div');
    card.className = 'card' + (tab === 'live' ? ' live' : '');
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const url = posterOf(x);
    thumb.dataset.icon = tab === 'live' ? '📺' : '🎬';
    if (url) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => {                         // direct load failed -> try main proxy (UA/no-referer)
        img.onerror = () => posterFallback(img);    // proxy result failed too -> icon
        api.fetchImage(url).then(d => { if (d) img.src = d; else posterFallback(img); }).catch(() => posterFallback(img));
      };
      img.src = url;
      thumb.appendChild(img);
    } else thumb.textContent = thumb.dataset.icon;
    const cap = div('cap', title);
    const fav = document.createElement('button');
    fav.className = 'card-fav' + (isFav(x) ? ' on' : '');
    fav.textContent = isFav(x) ? '♥' : '♡';
    fav.title = 'Favori';
    fav.onclick = (ev) => {
      ev.stopPropagation();
      toggleFav(x);
      const on = isFav(x);
      fav.classList.toggle('on', on); fav.textContent = on ? '♥' : '♡';
      if (activeCatId === '__fav__') loadFav();   // viewing favorites: drop removed card
      renderCats();                               // show/hide the ⭐ category
    };
    card.appendChild(fav);
    card.appendChild(thumb); card.appendChild(cap);
    if (tab === 'live') card.onclick = () => playLive(x);   // channels: click plays
    else card.onclick = () => openDetail(x);                // movies/series: click opens detail
    el.appendChild(card);
  }
  if (!list.length) el.innerHTML = '<div class="item">Sonuç yok</div>';
}
$('itemSearch').oninput = () => { if (activeCatId === '__resume__') loadResume(); else renderItems(); };

// ---------- Resume ("İzlemeye devam et") ----------
function loadResume() {
  $('listTitle').textContent = 'İzlemeye devam et';
  const q = $('itemSearch').value.toLowerCase();
  const list = watchFor(tab).filter(e => !q || ((e.item && e.item.name) || '').toLowerCase().includes(q));
  const el = $('list'); el.classList.add('cards'); el.innerHTML = '';
  if (!list.length) { el.innerHTML = '<div class="item">Kayıt yok</div>'; return; }
  const clr = document.createElement('button'); clr.className = 'clear-all'; clr.textContent = 'Tümünü temizle';
  clr.onclick = () => { if (confirm('Tüm izleme geçmişi silinsin?')) clearWatchTab(tab); };
  el.appendChild(clr);
  for (const e of list) {
    const card = document.createElement('div'); card.className = 'card';
    const del = document.createElement('button'); del.className = 'card-del'; del.textContent = '✕'; del.title = 'Geçmişten kaldır';
    del.onclick = (ev) => { ev.stopPropagation(); removeWatch(e.key); };
    card.appendChild(del);
    const thumb = document.createElement('div'); thumb.className = 'thumb';
    thumb.dataset.icon = '🎬';
    const url = (e.item && e.item.poster) || (e.series && e.series.poster) || '';
    if (url) {
      const img = document.createElement('img'); img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.onerror = () => posterFallback(img); api.fetchImage(url).then(d => { if (d) img.src = d; else posterFallback(img); }).catch(() => posterFallback(img)); };
      img.src = url; thumb.appendChild(img);
    } else thumb.textContent = '🎬';
    const pct = e.duration ? Math.min(100, Math.round((e.position / e.duration) * 100)) : 0;
    const prog = document.createElement('div'); prog.className = 'card-progress';
    const bar = document.createElement('div'); bar.style.width = pct + '%'; prog.appendChild(bar);
    thumb.appendChild(prog);
    card.appendChild(thumb);
    card.appendChild(div('cap', (e.item && e.item.name) || 'İçerik'));
    card.onclick = () => resumePlay(e);
    el.appendChild(card);
  }
}
function resumePlay(e) {
  if (e.kind === 'movie') playMovie(e.item, e.item.ext, e.position);
  else if (e.kind === 'series') playEpisode(e.ep, e.series, e.season, e.position);
}
function afterWatchChange() {
  if (watchFor(tab).length) loadResume();
  else { activeCatId = null; loadCats(); }   // resume category gone -> back to first category
}
function removeWatch(key) { const w = getWatch(); delete w[key]; saveWatch(w); afterWatchChange(); }
function clearWatchTab(t) { const w = getWatch(); for (const k of Object.keys(w)) if (w[k].tab === t) delete w[k]; saveWatch(w); afterWatchChange(); }

// ---------- Virtual category loaders ----------
function loadFav() {
  $('listTitle').textContent = 'Favoriler';
  items = favFor(tab).map(e => e.item);
  renderItems();
  if (!items.length) $('list').innerHTML = '<div class="item">Favori yok — kartlardaki ♡ ile ekle</div>';
}
async function loadAll() {
  $('listTitle').textContent = 'Tümü';
  $('list').innerHTML = '<div class="item">Yükleniyor…</div>';
  try { items = await fetchAll(); renderItems(); }
  catch (e) { $('list').innerHTML = `<div class="item">Hata: ${esc(e.message)}</div>`; }
}
async function loadRecent() {
  $('listTitle').textContent = 'Yeni eklenenler';
  $('list').innerHTML = '<div class="item">Yükleniyor…</div>';
  try {
    const all = await fetchAll();
    items = all.slice().sort((a, b) => (+(b.added || 0)) - (+(a.added || 0))).slice(0, 60);
    renderItems();
  } catch (e) { $('list').innerHTML = `<div class="item">Hata: ${esc(e.message)}</div>`; }
}

// ---------- Item selection ----------
function selectCard(card) {
  document.querySelectorAll('#list .card.selected').forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');
}
async function onItem(x) {
  if (tab === 'live') return playLive(x);
  if (tab === 'movie') return playMovie(x);
  if (tab === 'series') return openSeries(x);
}

async function playLive(x) {
  isVod = false; curPlaying = null;   // live tv isn't tracked
  const url = await api.url('live', x.stream_id, 'ts');
  setNow(x.name || x.title, false);
  await api.play(url);
}

async function playMovie(x, extHint, startSec) {
  isVod = true;
  let ext = extHint || x.container_extension;
  if (!ext) { try { const info = await api.vodInfo(x.stream_id); ext = (info.movie_data && info.movie_data.container_extension) || ext; } catch {} }
  ext = ext || 'mp4';
  const url = await api.url('movie', x.stream_id, ext);
  curPlaying = { key: 'movie:' + x.stream_id, kind: 'movie', tab: 'movie',
    item: { stream_id: x.stream_id, name: x.name || x.title, poster: posterOf(x), ext } };
  setNow(x.name || x.title, true);
  await api.play(url, startSec);
}

// ---------- Detail modal ----------
let curDetail = null, curDetailExt = null;
function setDetailImage(img, url) {
  if (!url) { img.removeAttribute('src'); return; }
  img.onerror = () => { img.onerror = null; api.fetchImage(url).then(d => { if (d) img.src = d; }); };
  img.src = url;
}
function badge(text, cls) { const s = document.createElement('span'); s.textContent = text; if (cls) s.className = cls; return s; }
function closeDetail() { $('detail').classList.add('hidden'); curDetail = null; }

async function openDetail(x) {
  curDetail = x; curDetailExt = null;
  const isSeries = tab === 'series';
  $('detail').classList.remove('hidden');
  $('detailTitle').textContent = x.name || x.title || '';
  $('detailBadges').innerHTML = ''; $('detailCast').innerHTML = '';
  $('detailPlot').textContent = 'Yükleniyor…';
  $('detailEpisodes').classList.add('hidden'); $('detailEpisodes').innerHTML = '';
  $('detailWatch').classList.toggle('hidden', isSeries);
  $('detailHero').style.backgroundImage = '';
  setDetailImage($('detailPoster'), posterOf(x));
  try {
    if (isSeries) fillSeriesDetail(x, await api.seriesInfo(x.series_id));
    else fillMovieDetail(x, await api.vodInfo(x.stream_id));
  } catch (e) { $('detailPlot').textContent = 'Bilgi alınamadı: ' + esc(e.message || e); }
}

function fillHeroAndPoster(x, m) {
  const bd = (m.backdrop_path && m.backdrop_path[0]) || m.movie_image || m.cover_big || posterOf(x);
  if (bd) { const h = $('detailHero'); api.fetchImage(bd).then(d => { h.style.backgroundImage = `url("${(d || bd).replace(/"/g, '')}")`; }).catch(() => {}); }
  const p = m.movie_image || m.cover_big || posterOf(x);
  if (p) setDetailImage($('detailPoster'), p);
}
function fillMeta(x, m) {
  const b = $('detailBadges'); b.innerHTML = '';
  if (m.genre) b.appendChild(badge(m.genre));
  const yr = (m.releasedate || m.releaseDate || '').toString().slice(0, 4);
  if (yr) b.appendChild(badge(yr));
  if (m.duration) b.appendChild(badge(m.duration));
  if (m.rating) b.appendChild(badge('★ ' + m.rating, 'rating'));
  $('detailPlot').textContent = m.plot || m.description || 'Açıklama yok.';
  const c = $('detailCast'); c.innerHTML = '';
  (m.cast || m.actors || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10)
    .forEach(n => c.appendChild(badge(n)));
}
function fillMovieDetail(x, info) {
  const m = (info && info.info) || {};
  curDetailExt = (info && info.movie_data && info.movie_data.container_extension) || null;
  fillHeroAndPoster(x, m); fillMeta(x, m);
  $('detailWatch').classList.remove('hidden');
}
function fillSeriesDetail(x, info) {
  const m = (info && info.info) || {};
  fillHeroAndPoster(x, m); fillMeta(x, m);
  const episodes = (info && info.episodes) || {};
  const box = $('detailEpisodes'); box.classList.remove('hidden'); box.innerHTML = '';
  const seasons = Object.keys(episodes).sort((a, b) => (+a) - (+b));
  if (!seasons.length) { box.innerHTML = '<p style="color:var(--muted)">Bölüm bulunamadı.</p>'; return; }
  const wrap = div('season-sel', ''); const sel = document.createElement('select');
  for (const s of seasons) { const o = document.createElement('option'); o.value = s; o.textContent = 'Sezon ' + s; sel.appendChild(o); }
  wrap.appendChild(sel); box.appendChild(wrap);
  const list = document.createElement('div'); box.appendChild(list);
  const renderSeason = (s) => {
    list.innerHTML = '';
    for (const ep of episodes[s]) {
      const row = document.createElement('div'); row.className = 'ep-row';
      row.appendChild(div('epn', String(ep.episode_num || '?')));
      row.appendChild(div('ept', ep.title || ('Bölüm ' + ep.episode_num)));
      row.appendChild(div('epplay', '▶'));
      row.onclick = () => { closeDetail(); playEpisode(ep, x, s); };
      list.appendChild(row);
    }
  };
  sel.onchange = () => renderSeason(sel.value);
  renderSeason(seasons[0]);
}

$('detailClose').onclick = closeDetail;
$('detail').onclick = (e) => { if (e.target === $('detail')) closeDetail(); };
$('detailWatch').onclick = () => { const x = curDetail, ext = curDetailExt; closeDetail(); if (x) playMovie(x, ext); };

async function openSeries(x) {
  $('list').innerHTML = '<div class="item">Bölümler yükleniyor…</div>';
  try {
    const info = await api.seriesInfo(x.series_id);
    const episodes = info.episodes || {};
    $('list').classList.remove('cards');
    $('list').innerHTML = '';
    const back = div('item', '← Dizilere geri dön'); back.onclick = () => renderItems(); $('list').appendChild(back);
    const seasons = Object.keys(episodes).sort((a, b) => (+a) - (+b));
    for (const s of seasons) {
      const h = div('item', `Sezon ${s}`); h.style.color = 'var(--muted)'; h.style.cursor = 'default';
      $('list').appendChild(h);
      for (const ep of episodes[s]) {
        const d = div('item', `S${s}·B${ep.episode_num || '?'}  ${ep.title || ''}`);
        d.onclick = () => playEpisode(ep, x, s);
        $('list').appendChild(d);
      }
    }
  } catch (e) { $('list').innerHTML = `<div class="item">Hata: ${esc(e.message)}</div>`; }
}

async function playEpisode(ep, series, season, startSec) {
  isVod = true;
  const ext = ep.container_extension || (ep.info && ep.info.container_extension) || 'mp4';
  const url = await api.url('series', ep.id, ext);
  curPlaying = { key: 'series:' + series.series_id + ':' + ep.id, kind: 'series', tab: 'series',
    series: { series_id: series.series_id, name: series.name, poster: posterOf(series) },
    season, ep: { id: ep.id, episode_num: ep.episode_num, title: ep.title, ext },
    item: { name: `${series.name} · S${season}B${ep.episode_num}`, poster: posterOf(series) } };
  setNow(`${series.name} · S${season}B${ep.episode_num} ${ep.title || ''}`, true);
  await api.play(url, startSec);
}

// ---------- Player UI ----------
function setNow(title, vod) {
  document.body.classList.add('playing');   // reveal the player pane
  $('placeholder').classList.add('hidden');
  $('info').classList.add('hidden');        // no EPG/info panel below the video
  $('controls').classList.remove('hidden');
  $('nowTitle').textContent = title || '';
  api.setBarTitle(title || '');
  $('seek').disabled = !vod;
  $('seek').style.opacity = vod ? '1' : '.4';
  paused = false; $('btnPause').innerHTML = ICON_PAUSE;
  // hide language menus until a new track-list arrives for this item
  for (const id of ['audioSel', 'subSel']) { $(id).innerHTML = ''; $(id).classList.add('hidden'); }
  api.setVideoVisible(true);
  repushBounds(); // player just appeared; re-fit video a few times as layout settles
}

// Push video bounds across the next few frames so the surface lands exactly on
// the pane even while the grid reflows (2-col -> 3-col when the player opens).
function repushBounds() {
  requestAnimationFrame(pushBounds);
  for (const d of [50, 150, 350]) setTimeout(pushBounds, d);
}

$('btnPause').onclick = async () => { await api.pause(); };
function stopPlayback() {
  writeWatch();                                 // remember where we stopped
  api.stop();
  document.body.classList.remove('playing');   // hide player, back to wide card grid
  $('controls').classList.add('hidden'); $('info').classList.add('hidden');
  $('placeholder').classList.remove('hidden'); api.setVideoVisible(false);
}
api.onDoStop(() => { applyFs(false); stopPlayback(); });   // close (X) overlay pressed
$('btnBack').onclick = () => api.seekRel(-10);
$('btnFwd').onclick = () => api.seekRel(10);
$('btnFs').onclick = () => toggleFs();

const isFs = () => document.body.classList.contains('fs'); // single source of truth
function applyFs(v) {               // UI only; the fullscreen bar is a separate overlay window
  document.body.classList.toggle('fs', !!v);
  requestAnimationFrame(() => setTimeout(pushBounds, 60)); // resize video surface after layout
}
function toggleFs(force) {          // user-initiated: update UI + tell main
  const v = force === undefined ? !isFs() : force;
  applyFs(v);
  api.setFullscreen(v);
}
api.onApplyFullscreen((v) => applyFs(v)); // global F/Esc came through main
document.addEventListener('keydown', (e) => {
  if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'Escape') {
    if (!$('detail').classList.contains('hidden')) closeDetail();
    else if (isFs()) toggleFs(false);
  }
  else if (e.key === 'f' || e.key === 'F') toggleFs();
  else if (e.key === ' ') { e.preventDefault(); api.pause(); }
});

$('vol').oninput = () => { api.volume(+$('vol').value); updateMuteIcon(); };
$('seek').oninput = () => { if (duration > 0) api.seek((+$('seek').value / 1000) * duration); };
$('audioSel').onchange = () => api.setAudio($('audioSel').value);
$('subSel').onchange = () => api.setSub($('subSel').value);

// mute toggle (no separate mpv mute; ride the volume slider)
let lastVol = 50;
$('btnMute').onclick = () => {
  const v = +$('vol').value;
  if (v > 0) { lastVol = v; $('vol').value = 0; } else { $('vol').value = lastVol || 50; }
  api.volume(+$('vol').value); updateMuteIcon();
};
function updateMuteIcon() { $('btnMute').textContent = (+$('vol').value === 0) ? '🔇' : '🔊'; }

// responsive control bar: drop low-priority items as it gets narrow (nothing overlaps/clips)
const CTL_RULES = [
  ['.c-title', 640], ['.c-trk', 540], ['.c-time', 470], ['.c-skip', 410], ['.c-vol', 350],
];
function fitControls() {
  const w = $('controls').clientWidth || 9999;
  for (const [sel, min] of CTL_RULES)
    document.querySelectorAll('#controls ' + sel).forEach(el => el.classList.toggle('r-hide', w < min));
}
new ResizeObserver(fitControls).observe($('controls'));

api.onMpvEvent(({ name, data }) => {
  if (name === 'duration') duration = data || 0;
  else if (name === 'time-pos') { curTime = data || 0; updateTime(); maybeSaveProgress(); }
  else if (name === 'pause') { paused = !!data; $('btnPause').innerHTML = paused ? ICON_PLAY : ICON_PAUSE; }
  else if (name === 'volume' && data != null && document.activeElement !== $('vol')) $('vol').value = Math.round(data);
  else if (name === 'track-list') fillTracks(data);
  else if (name === 'aid' && data != null) $('audioSel').value = String(data);
  else if (name === 'sid') $('subSel').value = data == null ? 'no' : String(data);
  else if (STAT_KEYS.includes(name)) { videoStats[name] = data; if (infoOpen) renderVideoInfo(); }
});

// ---------- Playback stats (info panel) ----------
const STAT_KEYS = ['width', 'height', 'container-fps', 'estimated-vf-fps', 'video-bitrate', 'audio-bitrate', 'video-codec', 'audio-codec-name', 'hwdec-current'];
let videoStats = {}, infoOpen = false;
function fmtBitrate(bps) { if (!bps) return null; return bps >= 1e6 ? (bps / 1e6).toFixed(2) + ' Mbps' : Math.round(bps / 1e3) + ' kbps'; }
function stat(label, val) { return val ? `<span class="st">${label}: <b>${esc(val)}</b></span>` : ''; }
function renderVideoInfo() {
  const s = videoStats;
  const res = (s.width && s.height) ? `${s.width}×${s.height}` : null;
  const fps = s['estimated-vf-fps'] || s['container-fps'];
  const fpsTxt = fps ? (Math.round(fps * 100) / 100) + ' fps' : null;
  const html = [
    stat('Çözünürlük', res),
    stat('FPS', fpsTxt),
    stat('Video', s['video-codec']),
    stat('Video bitrate', fmtBitrate(s['video-bitrate'])),
    stat('Ses', s['audio-codec-name']),
    stat('Ses bitrate', fmtBitrate(s['audio-bitrate'])),
    stat('Donanım', s['hwdec-current'] && s['hwdec-current'] !== 'no' ? s['hwdec-current'] : null),
  ].filter(Boolean).join('');
  $('videoInfo').innerHTML = html || '<span class="st">Bilgi bekleniyor…</span>';
}
$('btnInfo').onclick = () => {
  infoOpen = !infoOpen;
  $('videoInfo').classList.toggle('hidden', !infoOpen);
  $('btnInfo').classList.toggle('on', infoOpen);
  if (infoOpen) { renderVideoInfo(); repushBounds(); } else repushBounds();
};

// audio (dublaj) + subtitle (altyazı) language menus, from mpv track-list
function fillTracks(list) {
  list = Array.isArray(list) ? list : [];
  fillSel($('audioSel'), list.filter(t => t.type === 'audio'), false);
  fillSel($('subSel'), list.filter(t => t.type === 'sub'), true);
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
  if (t.lang) parts.push(String(t.lang).toUpperCase());
  if (t.title) parts.push(t.title);
  return parts.join(' · ') || ('#' + t.id);
}
function opt(v, txt) { const o = document.createElement('option'); o.value = v; o.textContent = txt; return o; }

function updateTime() {
  $('time').textContent = `${fmtTime(curTime)} / ${fmtTime(duration)}`;
  if (isVod && duration > 0 && document.activeElement !== $('seek'))
    $('seek').value = Math.round((curTime / duration) * 1000);
}

// ---------- EPG / info ----------
async function showEpg(streamId, name) {
  const box = $('info'); box.classList.remove('hidden');
  box.innerHTML = 'EPG yükleniyor…';
  try {
    const r = await api.epg(streamId, 6);
    const list = (r && r.epg_listings) || [];
    if (!list.length) { box.innerHTML = `<b>${esc(name || '')}</b> — program bilgisi yok`; return; }
    box.innerHTML = `<b>${esc(name || '')}</b><br>` + list.map(e => {
      const t = b64(e.title), st = tsToHM(e.start_timestamp), en = tsToHM(e.stop_timestamp);
      return `<span class="badge">${st}–${en}</span>${esc(t)}`;
    }).join('<br>');
  } catch { box.innerHTML = `<b>${esc(name || '')}</b>`; }
}

function showMovieInfo(info, x) {
  const m = (info && info.info) || {};
  const box = $('info'); box.classList.remove('hidden');
  box.innerHTML = `<b>${esc(x.name || x.title)}</b> ${m.releasedate ? '<span class="badge">' + esc(m.releasedate) + '</span>' : ''}`
    + (m.rating ? `<span class="badge">★ ${esc(m.rating)}</span>` : '')
    + (m.genre ? `<span class="badge">${esc(m.genre)}</span>` : '')
    + (m.plot ? `<br>${esc(m.plot)}` : '');
}

function showSeriesInfo(info, x) {
  const m = (info && info.info) || {};
  const box = $('info'); box.classList.remove('hidden');
  box.innerHTML = `<b>${esc(x.name)}</b> `
    + (m.genre ? `<span class="badge">${esc(m.genre)}</span>` : '')
    + (m.rating ? `<span class="badge">★ ${esc(m.rating)}</span>` : '')
    + (m.plot ? `<br>${esc(m.plot)}` : '');
}

// ---------- Video surface bounds ----------
function pushBounds() {
  const r = $('videoPane').getBoundingClientRect();
  api.setVideoBounds({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
}
const ro = new ResizeObserver(() => pushBounds());
ro.observe($('videoPane'));
window.addEventListener('resize', pushBounds);
api.onRequestBounds(() => pushBounds());
document.addEventListener('scroll', pushBounds, true);

// ---------- helpers ----------
function div(cls, text) { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function b64(s) { try { return decodeURIComponent(escape(atob(s || ''))); } catch { return s || ''; } }
function fmtTime(sec) { sec = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); }
function tsToHM(ts) { const d = new Date((+ts) * 1000); return isNaN(d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function fmtDate(ts) { const d = new Date((+ts) * 1000); return isNaN(d) ? '' : d.toLocaleDateString(); }
})();
