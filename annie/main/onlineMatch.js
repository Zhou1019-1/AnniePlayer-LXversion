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

const PROVIDERS = ['wy', 'kg', 'kw', 'tx', 'mg'];
const PROVIDER_LABEL = { wy: '网易云', kg: '酷狗', kw: '酷我', tx: 'QQ音乐', mg: '咪咕' };

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

/** 搜索候选：五平台并行（各取前 5），按匹配度排序返回前 15 */
async function searchCandidates({ path: filePath, keyword }) {
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
  const settled = await Promise.allSettled(PROVIDERS.map((p) =>
    streaming.search({ provider: p, keywords: kw, page: 1, limit: 5 })));
  const cands = [];
  settled.forEach((r, i) => {
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
  cands.sort((a, b) => b.score - a.score);
  return { ok: true, local, keyword: kw, candidates: cands.slice(0, 15) };
}

/** 应用匹配：歌词旁挂 .lrc；封面写目录 cover.jpg（可被 overwriteCover 控制覆盖）；可选嵌入标签 */
async function applyMatch({ path: filePath, provider, song, saveLrc, saveCover, embed, overwriteCover }) {
  if (!filePath || filePath.includes('#')) return { ok: false, reason: 'CUE/ISO 分轨暂不支持在线匹配' };
  if (!song || !provider) return { ok: false, reason: '缺少目标曲目' };
  const out = { ok: true, lrc: '', cover: '', embedded: false, notes: [] };

  // 1) 拉歌词（旁挂 / 嵌入都需要时只拉一次）
  let lrc = '';
  if (saveLrc || embed) {
    const lr = await streaming.lyric({ provider, song }).catch(() => null);
    if (lr && lr.lrc) lrc = lr.lrc;
  }
  if (saveLrc) {
    if (lrc && lrc.trim()) {
      tagWriter.writeLyric({ dest: filePath, lrc, tlyric: '' });
      out.lrc = filePath.replace(/\.[^.]+$/, '.lrc');
    } else out.notes.push('该平台未取到歌词');
  }

  // 2) 拉封面（song.cover 缺失时 getPic 补全）
  let coverBuf = null;
  let coverUrl = song.cover || (song.meta && song.meta.img) || '';
  if (saveCover || embed) {
    if (!coverUrl) {
      const pc = await streaming.getPic({ provider, song }).catch(() => null);
      if (pc && pc.url) coverUrl = pc.url;
    }
    if (coverUrl) coverBuf = await tagWriter.fetchCoverBytes(coverUrl).catch(() => null);
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
    } else out.notes.push('该平台未取到封面');
  }

  // 3) 可选：嵌入文件标签（ffmpeg remux，不改标题等既有标签，仅补歌词/封面）
  if (embed && (lrc || coverBuf)) {
    const r = await tagWriter.writeTags({ dest: filePath, lyrics: lrc, coverBytes: coverBuf }).catch(() => null);
    if (r && r.ok) out.embedded = true;
    else out.notes.push('标签嵌入失败（格式不支持或文件被占用）');
  }
  if (!out.lrc && !out.cover && !out.embedded && !out.notes.length) out.notes.push('未执行任何保存操作');
  return out;
}

module.exports = { searchCandidates, applyMatch };
