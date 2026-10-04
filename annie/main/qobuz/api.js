/**
 * qobuz-core/api.js —— Qobuz API 层（JS 重写，参考 streamrip 公开实现）
 *
 * 与 QBDLX 同策略：不内置任何 app_id/secret，运行时从 play.qobuz.com
 * 公开 bundle.js 动态抓取。签名算法参考 streamrip（MIT）的 qobuz.py。
 *
 * 用法：
 *   const qz = require('./api');
 *   const c = await qz.login({ email, password });        // 或 { userId, token }
 *   const alb = await c.albumGet(albumId);
 *   const url = await c.getFileUrl(trackId, 4);            // 1=MP3 2=16/44 3=24/96 4=24/192
 */
'use strict';
const crypto = require('crypto');

const BASE = 'https://www.qobuz.com/api.json/0.2';
const QUALITY_MAP = [5, 6, 7, 27]; // 档位 1-4 → format_id
// streamrip 用来试 secret 的公共曲目（任何账号都可请求，401/200 都算 secret 有效）
const SECRET_TEST_TRACK = '19512574';

// 默认凭据对：Qobuz 官方安卓客户端的公开 app_id/secret
// （qobuz-qt 等多个开源项目内置同款，社区公开流通 2026 年仍有效）。
// 实测：该对支持密码登录；bundle.js 抓取的网页端 app_id 拒绝密码登录（401），
// 网页端 secret 与 app_id 配对校验，不可混用。界面保留手工覆盖入口（同 QBDLX）。
const DEFAULT_APP_ID = '312369995';
const DEFAULT_APP_SECRET = 'e79f8b9be485692b0e5f9dd895826368';

const RE_BUNDLE = /<script src="(\/resources\/\d+\.\d+\.\d+-[a-z]\d{3}\/bundle\.js)"><\/script>/;
const RE_APPID_PROD = /production:{api:{appId:"(?<app_id>\d{9})",appSecret:"(\w{32})/;
const RE_APPID_ALL = /appId:"(\d{9})"/g;
const RE_SEED = /[a-z]\.initialSeed\("(?<seed>[\w=]+)",window\.utimezone\.(?<timezone>[a-z]+)\)/g;

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }

/* V4.3.22 修复：HTTP 层可注入。默认全局 fetch 不走 Windows 系统代理，
 * 由 index.js 注入 Electron net.fetch（跟随系统代理）。 */
let httpFetch = globalThis.fetch;
function setHttpFetch(fn) { if (typeof fn === 'function') httpFetch = fn; }

async function fetchText(url) {
  const r = await httpFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.text();
}

/** 从网页播放器 bundle.js 抓取候选 app_id 列表与候选 secrets（无需账号）。
 *  2026-09 实测：bundle 里有多个 appId，production 那个未必能直接密码登录（401），
 *  所以返回全部候选（production 优先），登录时逐个探测。 */
async function getAppIdAndSecrets() {
  const loginPage = await fetchText('https://play.qobuz.com/login');
  const mBundle = RE_BUNDLE.exec(loginPage);
  if (!mBundle) throw new Error('bundle.js 地址未找到（Qobuz 页面改版？）');
  const bundle = await fetchText('https://play.qobuz.com' + mBundle[1]);

  // app_id 候选：production 上下文优先，其余按出现顺序去重补充
  const appIds = [];
  const mProd = RE_APPID_PROD.exec(bundle);
  if (mProd) appIds.push(mProd.groups.app_id);
  RE_APPID_ALL.lastIndex = 0;
  let m;
  while ((m = RE_APPID_ALL.exec(bundle))) {
    if (!appIds.includes(m[1])) appIds.push(m[1]);
  }
  if (!appIds.length) throw new Error('app_id 未找到（bundle.js 混淆方式变了？）');

  // 收集 seed/timezone 对，保持出现顺序
  const secrets = new Map(); // timezone -> [seed, info?, extras?]
  RE_SEED.lastIndex = 0;
  while ((m = RE_SEED.exec(bundle))) {
    if (!secrets.has(m.groups.timezone)) secrets.set(m.groups.timezone, [m.groups.seed]);
  }
  if (!secrets.size) throw new Error('seed/timezone 未找到');

  // streamrip 注释：Qobuz 用两个恒 false 的三元表达式，实际生效的是第二个
  // seed/timezone 对，所以把第二项挪到最前优先尝试（Map 按插入序，重建实现）
  const keys = [...secrets.keys()];
  if (keys.length > 1) {
    const ordered = new Map();
    ordered.set(keys[1], secrets.get(keys[1]));
    for (const k of keys) if (k !== keys[1]) ordered.set(k, secrets.get(k));
    secrets.clear();
    for (const [k, v] of ordered) secrets.set(k, v);
  }

  // info/extras 拼接（timezone 首字母大写形式出现在另一段代码里）
  const tzAlt = [...secrets.keys()].map((t) => t[0].toUpperCase() + t.slice(1)).join('|');
  const RE_INFO = new RegExp('name:"\\w+/(?<timezone>' + tzAlt + ')",info:"(?<info>[\\w=]+)",extras:"(?<extras>[\\w=]+)"', 'g');
  while ((m = RE_INFO.exec(bundle))) {
    const tz = m.groups.timezone.toLowerCase();
    if (secrets.has(tz)) secrets.get(tz).push(m.groups.info, m.groups.extras);
  }

  // 拼接后 base64 解码（去掉末 44 字符）
  const out = [];
  for (const parts of secrets.values()) {
    const joined = parts.join('');
    const s = Buffer.from(joined.slice(0, -44), 'base64').toString('utf8');
    if (s && !out.includes(s)) out.push(s);
  }
  if (!out.length) throw new Error('secret 推导失败');
  return { appIds, secrets: out };
}

class QobuzClient {
  constructor() {
    this.appId = null;
    this.appIds = [];        // 候选列表（登录探测用）
    this.secrets = [];
    this.secret = null;      // 实测可用的那个
    this.token = null;       // user_auth_token
    this.user = null;
  }

  async _api(epoint, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
    if (this.appId) headers['X-App-Id'] = this.appId;
    if (this.token) headers['X-User-Auth-Token'] = this.token;
    const r = await httpFetch(BASE + '/' + epoint + '?' + qs, { headers });
    let body = null;
    try { body = await r.json(); } catch { /* 非 JSON */ }
    return { status: r.status, body };
  }

  /**
   * 登录。creds: { email, password } 或 { userId, token }；
   * 可用 opts { appId, secret } 覆盖默认凭据对。
   * 返回 { user, credential }；免费账号抛 IneligibleError
   */
  async login(creds, opts) {
    // 候选对：opts > 默认安卓对 > bundle.js 抓取（网页端，密码登录多半被拒，token 登录可能可用）
    if (opts && opts.appId) { this.appIds = [opts.appId]; }
    if (opts && opts.secret) this.secret = opts.secret;
    if (!this.appIds.length) {
      this.appIds = [DEFAULT_APP_ID];
      if (!this.secret) this.secret = DEFAULT_APP_SECRET;
    }
    if (!this.secrets.length) this.secrets = this.secret ? [this.secret] : [];
    // 逐个 app_id 探测登录（bundle 里多个候选，production 未必能密码登录）
    let body = null, lastErr = null;
    for (const id of this.appIds) {
      this.appId = id;
      const params = { app_id: id };
      if (creds.token) {
        params.user_id = creds.userId;
        params.user_auth_token = creds.token;
      } else {
        params.email = creds.email;
        params.password = creds.password;
      }
      const r = await this._api('user/login', params);
      if (r.status === 200) { body = r.body; break; }
      if (r.status === 400) { lastErr = Object.assign(new Error('app_id ' + id + ' 无效（400）'), { code: 'APPID' }); continue; }
      if (r.status === 401) { lastErr = Object.assign(new Error('app_id ' + id + ' 拒绝（401）'), { code: 'AUTH', status: 401 }); continue; }
      throw new Error('登录失败 HTTP ' + r.status + ' ' + JSON.stringify(r.body && r.body.message));
    }
    if (!body) {
      // 所有候选都被拒：401 居多说明账号密码可能真错，但也可能是 Qobuz 改版
      const authish = lastErr && lastErr.status === 401;
      throw Object.assign(new Error(authish
        ? '所有候选 app_id 均 401：账号密码错误或 Qobuz 登录策略改版'
        : (lastErr ? lastErr.message : '登录失败')), { code: authish ? 'AUTH' : 'APPID' });
    }

    this.token = body.user_auth_token;
    this.user = body.user;
    const cred = body.user && body.user.credential;
    if (!cred || !cred.parameters) {
      throw Object.assign(new Error('免费账号无法下载/完整播放（Qobuz 官方限制）'), { code: 'FREE' });
    }
    // 逐个试出可用 secret（默认/手工已给 secret 时先信任，失败再抓 bundle.js 补充候选）
    if (!this.secret) this.secret = await this._findValidSecret();
    return { user: this.user, credential: cred };
  }

  /** getFileUrl 签名无效时调用：重抓 bundle.js 候选 secret 再试（返回是否找到新的） */
  async refreshSecret() {
    try {
      const got = await getAppIdAndSecrets();
      this.secrets = [...new Set([...(this.secret ? [this.secret] : []), ...got.secrets])];
      this.secret = null;
      this.secret = await this._findValidSecret();
      return true;
    } catch { return false; }
  }

  async _requestFileUrl(trackId, quality, secret) {
    const fmt = QUALITY_MAP[quality - 1] || QUALITY_MAP[1];
    const ts = Math.floor(Date.now() / 1000);
    const sig = md5('trackgetFileUrlformat_id' + fmt + 'intentstreamtrack_id' + trackId + ts + secret);
    return this._api('track/getFileUrl', {
      request_ts: ts, request_sig: sig, track_id: trackId, format_id: fmt, intent: 'stream',
    });
  }

  async _findValidSecret() {
    for (const s of this.secrets) {
      const { status } = await this._requestFileUrl(SECRET_TEST_TRACK, 4, s);
      if (status === 200 || status === 401) return s; // 400 = secret 无效
    }
    throw Object.assign(new Error('所有候选 secret 均无效（Qobuz 改版？可手工填入）'), { code: 'SECRET' });
  }

  /** 取播放/下载直链。quality 1-4；受限时抛 NonStreamableError（code: 'RESTRICT'） */
  async getFileUrl(trackId, quality) {
    const { status, body } = await this._requestFileUrl(trackId, quality, this.secret);
    if (status === 401) throw Object.assign(new Error('登录态失效（401），需重新登录'), { code: 'AUTH' });
    if (status !== 200) throw new Error('getFileUrl 失败 HTTP ' + status);
    if (!body.url) {
      const r0 = body.restrictions && body.restrictions[0];
      throw Object.assign(new Error('曲目受限：' + (r0 ? r0.code : 'unknown')), { code: 'RESTRICT', restrictions: body.restrictions });
    }
    return body; // { url, format_id, mime_type, sampling_rate, bit_depth, ... }
  }

  // ---- 元数据/搜索封装（与 streamrip 端点一致）----
  async albumGet(id) { return (await this._api('album/get', { app_id: this.appId, album_id: id, limit: 500, offset: 0 })).body; }
  async trackGet(id) { return (await this._api('track/get', { app_id: this.appId, track_id: id })).body; }
  async playlistGet(id) { return (await this._api('playlist/get', { app_id: this.appId, playlist_id: id, extra: 'tracks', limit: 500, offset: 0 })).body; }
  async artistGet(id) { return (await this._api('artist/get', { app_id: this.appId, artist_id: id, extra: 'albums', limit: 500, offset: 0 })).body; }
  async labelGet(id) { return (await this._api('label/get', { app_id: this.appId, label_id: id, extra: 'albums', limit: 500, offset: 0 })).body; }
  async search(type, query, limit) { // type: artist/album/track/playlist
    return (await this._api(type + '/search', { query, limit: limit || 50 })).body;
  }
  async favorites(type, limit) { // type: track/artist/album
    return (await this._api('favorite/getUserFavorites', { type: type + 's', limit: limit || 500 })).body;
  }
  async userPlaylists(limit) {
    return (await this._api('playlist/getUserPlaylists', { limit: limit || 500 })).body;
  }

  /* 收藏写入（QBDLX 未做，官方 Web API 同款）。专辑/单曲/艺人走 favorite/*，歌单走 playlist/subscribe */
  async _fav(op, type, id) { // op: create|delete；type: album|track|artist
    const p = { app_id: this.appId }; p[type + '_ids'] = id;
    const r = await this._api('favorite/' + op, p);
    if (r.status >= 400) throw Object.assign(new Error('收藏操作失败：HTTP ' + r.status), { code: r.status === 401 ? 'AUTH' : undefined });
    return true;
  }
  favAdd(type, id) { return this._fav('create', type, id); }
  favDel(type, id) { return this._fav('delete', type, id); }
  async playlistSubscribe(id, unsub) {
    const r = await this._api('playlist/' + (unsub ? 'unsubscribe' : 'subscribe'), { playlist_id: id });
    if (r.status >= 400) throw Object.assign(new Error('歌单收藏失败：HTTP ' + r.status), { code: r.status === 401 ? 'AUTH' : undefined });
    return true;
  }
}

async function login(creds) {
  const c = new QobuzClient();
  await c.login(creds);
  return c;
}

module.exports = { login, QobuzClient, getAppIdAndSecrets, QUALITY_MAP, DEFAULT_APP_ID, DEFAULT_APP_SECRET, setHttpFetch };
