'use strict';
// ============================================================================
// 在线歌词 / 封面匹配（一期：单曲手动匹配）
//   链路：读本地标签 → 五平台搜索（洛雪 lx-sdk）→ 匹配度打分排序 → 用户选定 →
//         歌词写旁挂同名 .lrc / 封面写目录 cover.jpg（专辑共享，findExternalCover 识别）/
//         可选嵌入文件标签（tagWriter，ffmpeg remux）
//   注意：仅处理本地实体文件；CUE/ISO 虚拟分轨（path 含 # 片段）不支持。
// ============================================================================
const fs = require('fs');
const path = require('path');
const library = require('./library');
const streaming = require('./streaming');
const tagWriter = require('./tagWriter');
const extMeta = require('./extMeta'); // V4.4.3：国际补充源（LRCLIB 歌词 / MusicBrainz 标签 / CAA 封面）

const PROVIDERS = ['wy', 'kg', 'kw', 'tx', 'mg'];
const PROVIDER_LABEL = { wy: '网易云', kg: '酷狗', kw: '酷我', tx: 'QQ音乐', mg: '咪咕', lrclib: 'LRCLIB', musicbrainz: 'MusicBrainz' };

/* CAA 是境外服务：惰性使用 net.fetch 跟随系统代理；CI 纯 Node 测试不加载 electron。 */
function caaFetch(url, opts) {
  const { net } = require('electron');
  return net.fetch(url, opts);
}

/** 标题/艺人归一化：去括号注释（Live/Remix/feat.）、去标点空白、小写 */
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[（(【\[][^（）()【】\[\]]*[）)】\]]/g, '')
    .replace(/\s*(feat\.?|featuring)\b.*$/i, '')
    .replace(/[\s\-_·•,，。.!！?？'"、~～]/g, '');
}

/** 匹配度打分：标题 60 + 艺人 25 + 时长 25 + 专辑 10，封顶 100 */
function scoreOf(local, song) {
  let sc = 0;
  const lt = norm(local.title), ct = norm(song.name);
  if (lt && ct) {
    if (lt === ct) sc += 60;
    else if (lt.includes(ct) || ct.includes(lt)) sc += 35;
  }
  const la = norm(local.artist), ca = norm(song.artist);
  if (la && ca) {
    if (la === ca) sc += 25;
    else if (la.includes(ca) || ca.includes(la)) sc += 18;
  } else if (!la) sc += 8;
  if (local.duration > 0 && song.duration > 0) {
    const diff = Math.abs(local.duration - song.duration) / 1000;
    if (diff <= 2) sc += 25; else if (diff <= 5) sc += 12;
  } else if (local.duration <= 0) sc += 8;
  const lm = norm(local.album), cm = norm(song.album);
  if (lm && cm && (lm === cm || lm.includes(cm) || cm.includes(lm))) sc += 10;
  return Math.min(100, sc);
}

/** V4.4.3：按候选来源取歌词（国内五源走 lx-sdk；LRCLIB 按 id 取；MusicBrainz 无歌词 → 转 LRCLIB 按元数据取） */
async function fetchLyricForCand(cand) {
  if (cand.provider === 'lrclib') {
    const r = await extMeta.lrclibById(cand._lrclib && cand._lrclib.id).catch(() => null);
    const lrc = (r && (r.syncedLyrics || r.plainLyrics)) || '';
    return lrc.trim() ? { lrc: r.syncedLyrics || r.plainLyrics, tlyric: '' } : null;
  }
  if (cand.provider === 'musicbrainz') {
    const mb = cand._mb || {};
    const r = await extMeta.lrclibGet({
      title: mb.title || cand.name || '', artist: mb.artist || cand.artist || '',
      album: mb.album || cand.album || '', durationSec: Math.round((mb.duration || cand.duration || 0) / 1000),
    }).catch(() => null);
    return (r && r.ok && r.lrc) ? { lrc: r.lrc, tlyric: '' } : null;
  }
  return streaming.lyric({ provider: cand.provider, song: cand.song }).catch(() => null);
}

/** 搜索候选：五平台 + 国际源（LRCLIB/MusicBrainz，intl=false 关闭）并行，按匹配度排序返回前 20 */
async function searchCandidates({ path: filePath, keyword, intl }) {
  if (!filePath || filePath.includes('#')) return { ok: false, reason: 'CUE/ISO 分轨暂不支持在线匹配' };
  const meta = await library.readMeta(filePath).catch(() => null);
  const local = {
    title: (meta && meta.title) || path.basename(filePath, path.extname(filePath)),
    artist: (meta && meta.artist) || '',
    album: (meta && meta.album) || '',
    duration: meta && meta.duration ? Math.round(meta.duration * 1000) : 0,
  };
  const kw = (keyword && String(keyword).trim()) || `${local.title} ${local.artist}`.trim();
  if (!kw) return { ok: false, reason: '缺少搜索关键词' };
  const wantIntl = intl !== false;
  const tasks = PROVIDERS.map((p) => streaming.search({ provider: p, keywords: kw, page: 1, limit: 5 }));
  if (wantIntl) {
    tasks.push(extMeta.lrclibSearch({ title: local.title, artist: local.artist, keyword: kw }));
    tasks.push(extMeta.mbSearch({ title: local.title, artist: local.artist, album: local.album, limit: 5 }));
  }
  const settled = await Promise.allSettled(tasks);
  const cands = [];
  settled.slice(0, PROVIDERS.length).forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value || !r.value.songs) return;
    r.value.songs.forEach((song) => {
      cands.push({
        provider: PROVIDERS[i],
        providerLabel: PROVIDER_LABEL[PROVIDERS[i]] || PROVIDERS[i],
        name: song.name || '', artist: song.artist || '', album: song.album || '',
        duration: song.duration || 0, interval: song.interval || '',
        cover: song.cover || '',
        score: scoreOf(local, song),
        song, // 原样回传（lyric/getPic 需要 meta 字段）
      });
    });
  });
  // 国际补充源：境外服务连不上时 allSettled 兜底为空，静默降级（定位是补充，国内五源是主力）
  if (wantIntl) {
    const rl = settled[PROVIDERS.length];
    if (rl && rl.status === 'fulfilled' && Array.isArray(rl.value)) {
      rl.value.forEach((t) => cands.push({
        provider: 'lrclib', providerLabel: PROVIDER_LABEL.lrclib,
        name: t.name, artist: t.artist, album: t.album, duration: t.duration, interval: '',
        cover: '', score: scoreOf(local, t), _lrclib: { id: t.id }, song: null,
      }));
    }
    const rm = settled[PROVIDERS.length + 1];
    if (rm && rm.status === 'fulfilled' && Array.isArray(rm.value)) {
      rm.value.forEach((t) => cands.push({
        provider: 'musicbrainz', providerLabel: PROVIDER_LABEL.musicbrainz,
        name: t.name, artist: t.artist, album: t.album, duration: t.duration, interval: '',
        cover: t.cover || '', score: scoreOf(local, t), _mb: t._mb, song: null,
      }));
    }
  }
  cands.sort((a, b) => b.score - a.score);
  return { ok: true, local, keyword: kw, candidates: cands.slice(0, 20) };
}

/** 应用匹配：歌词旁挂 .lrc；封面写目录 cover.jpg（可被 overwriteCover 控制覆盖）；可选嵌入标签 / 写入曲目标签。
 *  V4.4.3：支持国际源候选（lrclib/musicbrainz，经 _lrclib/_mb 回传）；writeTags=true 时写入曲目标签
 * （MusicBrainz 候选写全套：标题/艺人/专辑/专辑艺术家/曲目号/碟号/日期；其余来源只写标题/艺人/专辑三件套）。 */
async function applyMatch({ path: filePath, provider, song, _lrclib, _mb, saveLrc, saveCover, embed, overwriteCover, writeTags }) {
  if (!filePath || filePath.includes('#')) return { ok: false, reason: 'CUE/ISO 分轨暂不支持在线匹配' };
  if (!provider || (!song && !_lrclib && !_mb)) return { ok: false, reason: '缺少目标曲目' };
  const cand = { provider, song, _lrclib, _mb, name: (_mb && _mb.title) || (song && song.name) || '', artist: (_mb && _mb.artist) || (song && song.artist) || '', album: (_mb && _mb.album) || (song && song.album) || '', duration: (_mb && _mb.duration) || (song && song.duration) || 0 };
  const out = { ok: true, lrc: '', cover: '', embedded: false, tagged: false, notes: [] };
  const coverHttpFetch = provider === 'musicbrainz' ? caaFetch : null;

  // 1) 拉歌词（旁挂 / 嵌入 / 写标签都需要时只拉一次）；译文轨一并带回（外文歌词显示翻译行）
  let lrc = '', tlyric = '';
  if (saveLrc || embed || writeTags) {
    const lr = await fetchLyricForCand(cand);
    if (lr && lr.lrc) { lrc = lr.lrc; tlyric = lr.tlyric || ''; }
  }
  if (saveLrc) {
    if (lrc && lrc.trim()) {
      tagWriter.writeLyric({ dest: filePath, lrc, tlyric });
      out.lrc = filePath.replace(/\.[^.]+$/, '.lrc');
    } else out.notes.push('该来源未取到歌词');
  }

  // 2) 拉封面（洛雪：song.cover 缺失时 getPic 补；MusicBrainz：Cover Art Archive front-500；LRCLIB 无封面）
  let coverBuf = null;
  let coverUrl = provider === 'musicbrainz' ? extMeta.caaCover((_mb && _mb.releaseId) || '', 500)
    : (song && (song.cover || (song.meta && song.meta.img))) || '';
  if (saveCover || embed || writeTags) {
    if (!coverUrl && song) {
      const pc = await streaming.getPic({ provider, song }).catch(() => null);
      if (pc && pc.url) coverUrl = pc.url;
    }
    if (coverUrl) coverBuf = await tagWriter.fetchCoverBytes(coverUrl, 10000, 8 * 1024 * 1024, coverHttpFetch).catch(() => null);
  }
  if (saveCover) {
    if (coverBuf) {
      const isPng = coverBuf.length > 4 && coverBuf[0] === 0x89 && coverBuf[1] === 0x50;
      const coverPath = path.join(path.dirname(filePath), 'cover.' + (isPng ? 'png' : 'jpg'));
      if (fs.existsSync(coverPath) && !overwriteCover) {
        out.notes.push('目录已有封面文件，未覆盖');
      } else {
        try { fs.writeFileSync(coverPath, coverBuf); out.cover = coverPath; }
        catch (e) { out.notes.push('封面写入失败：' + e.message); }
      }
    } else out.notes.push('该来源未取到封面');
  }

  // 3) 写入曲目标签（writeTags）：MusicBrainz 全套 / 其余来源三件套；歌词已拉取则随标签一并嵌入
  if (writeTags) {
    const meta = _mb
      ? { title: _mb.title, artist: _mb.artist, album: _mb.album, albumArtist: _mb.albumArtist, track: _mb.track, disc: _mb.disc, date: _mb.date }
      : { title: cand.name, artist: cand.artist, album: cand.album };
    const wr = await tagWriter.writeTags({
      dest: filePath, ...meta,
      coverBytes: coverBuf || undefined, coverUrl: !coverBuf ? coverUrl || undefined : undefined,
      httpFetch: coverHttpFetch || undefined,
      lyrics: lrc || '', tlyric,
    }).catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
    if (wr && wr.ok) { out.tagged = true; if (lrc) out.embedded = true; }
    else out.notes.push('标签写入失败：' + ((wr && wr.reason) || '未知'));
  } else if (embed && (lrc || coverBuf)) {
    // 4) 可选：嵌入文件标签（ffmpeg remux，不改标题等既有标签，仅补歌词/封面）
    const r = await tagWriter.writeTags({ dest: filePath, lyrics: lrc, coverBytes: coverBuf }).catch(() => null);
    if (r && r.ok) out.embedded = true;
    else out.notes.push('标签嵌入失败（格式不支持或文件被占用）');
  }
  if (!out.lrc && !out.cover && !out.embedded && !out.tagged && !out.notes.length) out.notes.push('未执行任何保存操作');
  return out;
}

// ============================================================================
// 批量匹配（V4.3.4：整个曲库 / 文件夹 / 多选；只存旁挂 .lrc 歌词，封面仍走单曲手动）
//   策略：逐首五平台搜索取最高分候选，≥80% 才自动落盘（保守，防张冠李戴）；
//         已有旁挂 .lrc 的默认跳过（可选覆盖）；CUE/ISO 分轨跳过；全程可取消。
// ============================================================================
const batch = { running: false, canceled: false };

function sidecarLrc(p) { return p.replace(/\.[^.]+$/, '.lrc'); }

async function batchStart(win, paths, opts) {
  if (batch.running) return { ok: false, reason: '批量匹配进行中' };
  batch.running = true; batch.canceled = false;
  const overwrite = !!(opts && opts.overwrite);
  const total = paths.length;
  let matched = 0, skipped = 0, failed = 0;
  const send = (ev) => { try { if (win && !win.isDestroyed()) win.webContents.send('match:batch:event', ev); } catch (e) { } };
  send({ type: 'begin', total });
  for (let i = 0; i < paths.length; i++) {
    if (batch.canceled) break;
    const p = paths[i];
    let st = 'failed', score = 0, note = '';
    try {
      if (p.includes('#')) { st = 'skipped'; note = 'CUE/ISO 分轨'; }
      else if (!overwrite && fs.existsSync(sidecarLrc(p))) { st = 'skipped'; note = '已有歌词'; }
      else {
        const r = await searchCandidates({ path: p });
        const best = r.ok && r.candidates.length ? r.candidates[0] : null;
        if (!best) note = '各平台均无结果';
        else if (best.score < 80) { score = best.score; note = '匹配度不足（' + best.score + '%）'; }
        else {
          score = best.score;
          const lr = await fetchLyricForCand(best); // V4.4.3：国际源候选（LRCLIB/MusicBrainz）同链路
          if (lr && lr.lrc && lr.lrc.trim()) {
            tagWriter.writeLyric({ dest: p, lrc: lr.lrc, tlyric: lr.tlyric || '' }); // 译文轨一并写入
            st = 'matched';
          } else note = '该来源无歌词';
        }
      }
    } catch (e) { note = (e && e.message) || String(e); }
    if (st === 'matched') matched++; else if (st === 'skipped') skipped++; else failed++;
    send({ type: 'progress', done: i + 1, total, path: p, result: st, score, note, matched, skipped, failed });
    await new Promise((r) => setTimeout(r, 150)); // 温和限速，防平台风控
  }
  const canceled = batch.canceled;
  batch.running = false;
  send({ type: 'end', canceled, done: matched + skipped + failed, total, matched, skipped, failed });
  return { ok: true };
}

function batchCancel() { batch.canceled = true; }

/** 播放时自动补全（V4.4）：无歌词的本地曲目实时五平台匹配（≥80% 取最高分），
 *  歌词 + 封面仅回显不落盘（落盘仍走手动/批量匹配）。 */
async function autoLyric({ path: filePath }) {
  if (!filePath || filePath.includes('#')) return { ok: false };
  const r = await searchCandidates({ path: filePath }).catch(() => null);
  if (!r || !r.ok || !r.candidates.length) return { ok: false };
  const best = r.candidates[0];
  if (!best || best.score < 80) return { ok: false };
  let cover = best.cover || (best.song && best.song.meta && best.song.meta.img) || '';
  const lr = await fetchLyricForCand(best); // V4.4.3：国际源候选同链路
  if (!cover && best.song) {
    const pc = await streaming.getPic({ provider: best.provider, song: best.song }).catch(() => null);
    if (pc && pc.url) cover = pc.url;
  }
  if (lr && lr.lrc && lr.lrc.trim()) {
    return { ok: true, lrc: lr.lrc, tlyric: lr.tlyric || '', cover, provider: best.providerLabel, score: best.score };
  }
  return { ok: false, cover }; // 歌词没拉到也把封面带回去补显
}

module.exports = { searchCandidates, applyMatch, batchStart, batchCancel, autoLyric };
