'use strict';
// Xtream Codes API client. Runs in main process (Node fetch, no CORS).

function normalizeBase(server) {
  let s = (server || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}

class Xtream {
  constructor({ server, username, password }) {
    this.base = normalizeBase(server);
    this.username = username;
    this.password = password;
  }

  _api(params) {
    const u = new URL(this.base + '/player_api.php');
    u.searchParams.set('username', this.username);
    u.searchParams.set('password', this.password);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    }
    return u.toString();
  }

  async _get(params) {
    const res = await fetch(this._api(params), {
      headers: { 'User-Agent': 'MNZ-IPTV/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { throw new Error('Invalid response (not JSON). Check server/credentials.'); }
  }

  // Auth + account info
  login() { return this._get({}); }

  getLiveCategories()   { return this._get({ action: 'get_live_categories' }); }
  getVodCategories()    { return this._get({ action: 'get_vod_categories' }); }
  getSeriesCategories() { return this._get({ action: 'get_series_categories' }); }

  getLiveStreams(catId)   { return this._get({ action: 'get_live_streams', category_id: catId }); }
  getVodStreams(catId)    { return this._get({ action: 'get_vod_streams', category_id: catId }); }
  getSeries(catId)        { return this._get({ action: 'get_series', category_id: catId }); }

  getVodInfo(vodId)       { return this._get({ action: 'get_vod_info', vod_id: vodId }); }
  getSeriesInfo(seriesId) { return this._get({ action: 'get_series_info', series_id: seriesId }); }
  getShortEpg(streamId, limit = 10) {
    return this._get({ action: 'get_short_epg', stream_id: streamId, limit });
  }

  // Stream URL builders
  liveUrl(streamId, ext = 'ts') {
    return `${this.base}/live/${enc(this.username)}/${enc(this.password)}/${streamId}.${ext}`;
  }
  movieUrl(streamId, ext) {
    return `${this.base}/movie/${enc(this.username)}/${enc(this.password)}/${streamId}.${ext || 'mp4'}`;
  }
  seriesUrl(episodeId, ext) {
    return `${this.base}/series/${enc(this.username)}/${enc(this.password)}/${episodeId}.${ext || 'mp4'}`;
  }
}

function enc(s) { return encodeURIComponent(s); }

module.exports = { Xtream };
