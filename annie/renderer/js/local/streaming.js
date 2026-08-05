'use strict';
/* 安妮播放器 SVLX —— 流媒体面板（洛雪全功能版，IIFE 包裹避免全局冲突）
 * 平台：酷狗 kg / 酷我 kw / 咪咕 mg / QQ tx / 网易 wy（洛雪 musicSdk 原版）
 * 播放 URL：用户导入的音源脚本优先，洛雪测试接口兜底；音质可选、分页加载、下载到本地曲库
 */
(function () {

const PLATFORMS = { kg: '酷狗音乐', kw: '酷我音乐', mg: '咪咕音乐', tx: 'QQ 音乐', wy: '网易云音乐' };

const streamState = {
  provider: 'kg',
  kw: '',             // 当前关键词
  page: 0,            // 已加载到的页码
  allPage: 1,
  results: [],        // 当前搜索结果（同时作为播放队列）
  index: -1,
  searching: false,
};

const $s = (s) => document.querySelector(s);

/* ---------------- 侧栏标签页切换 ---------------- */
document.querySelectorAll('.side-tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.side-tab').forEach(b => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.tab;
    $s('#panel-local').classList.toggle('active', tab === 'local');
    $s('#panel-stream').classList.toggle('active', tab === 'stream');
    if (tab === 'stream') $s('#stream-search').focus();
  };
});
$s('#btn-collapse2').onclick = () => $s('#btn-collapse').click();

/* ---------------- 平台标签 + 音质 ---------------- */
document.querySelectorAll('.pf-tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.pf-tab').forEach(b => b.classList.toggle('active', b === btn));
    streamState.provider = btn.dataset.pf;
    if (streamState.kw) doSearch(true);
  };
});

function currentQuality() {
  return $s('#stream-quality').value;
}

function setStreamStatus(text, warn) {
  const el = $s('#stream-status');
  el.textContent = text || '';
  el.classList.toggle('warn', !!warn);
}

/* ---------------- 热搜（已移除：按需求不显示搜索推荐） ---------------- */

/* ---------------- 本地命中（置顶显示） ---------------- */
function localMatches(kw) {
  const q = kw.toLowerCase();
  const out = [];
  for (const t of state.library.tracks) {
    const mc = state.library.metaCache[t.path] || {};
    const name = (mc.title || t.name.replace(/\.[^.]+$/, '')).toLowerCase();
    const artist = (mc.artist || '').toLowerCase();
    const album = (mc.album || '').toLowerCase();
    if (name.includes(q) || artist.includes(q) || album.includes(q)) {
      out.push({
        track: t,
        title: mc.title || t.name.replace(/\.[^.]+$/, ''),
        artist: mc.artist || '未知艺术家',
        album: mc.album || '',
        fmt: (mc.codec || t.name.split('.').pop()).toUpperCase() + (mc.bitrate ? ' · ' + Math.round(mc.bitrate / 1000) + 'kbps' : ''),
        fav: state.favorites.has(t.path)
      });
    }
    if (out.length >= 30) break;
  }
  return out;
}

function localDupOf(song) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s（）()\[\]【】·\-_.]/g, '');
  const n = norm(song.name), a = norm(song.artist);
  if (!n) return null;
  for (const t of state.library.tracks) {
    const mc = state.library.metaCache[t.path] || {};
    const tn = norm(mc.title || t.name.replace(/\.[^.]+$/, ''));
    const ta = norm(mc.artist);
    if (tn === n && (!a || !ta || ta === a || ta.includes(a) || a.includes(ta))) {
      const lossless = /\.(flac|wav|ape|aiff?|alac|tta|wv|dsf|dff)$/i.test(t.path);
      return { fav: state.favorites.has(t.path), lossless, path: t.path };
    }
  }
  return null;
}

/* ---------------- 搜索（洛雪式：单平台 + 分页） ---------------- */
async function doSearch(fresh) {
  const kw = $s('#stream-search').value.trim();
  if (!kw || streamState.searching) return;
  streamState.searching = true;
  const provider = streamState.provider;
  const pname = PLATFORMS[provider];
  const page = fresh ? 1 : streamState.page + 1;
  setStreamStatus(fresh ? `${pname} 搜索中…` : `${pname} 加载第 ${page} 页…`);
  try {
    const r = await window.mine.streamSearch({ provider, keywords: kw, page, limit: 30 });
    if (provider !== streamState.provider && fresh) return; // 平台已切换，丢弃旧结果
    if (fresh) {
      streamState.kw = kw;
      streamState.results = r.songs || [];
    } else {
      streamState.results = streamState.results.concat(r.songs || []);
    }
    streamState.page = r.page || page;
    streamState.allPage = r.allPage || 1;
    streamState.index = -1;
    renderResults();
    setStreamStatus(`${pname}：共 ${r.total ?? streamState.results.length} 首 · 已加载 ${streamState.results.length} 首（第 ${streamState.page}/${streamState.allPage} 页）`);
    prefetchCovers(); // 后台补齐列表封面（搜索后立即显示，无需等点击播放）
  } catch (e) {
    setStreamStatus('搜索失败：' + (e.message || e), true);
  } finally {
    streamState.searching = false;
  }
}

/* ---------------- 搜索结果封面预补齐 ----------------
 * 酷狗/酷我等平台搜索接口不带封面图（img:null），仅在播放时才 getPic 补齐。
 * 这里在搜索/分页完成后后台并发拉取无封面歌曲的封面，增量更新列表行，
 * 让搜索结果直接展示封面。并发 4 防止平台接口限流；播放流程的补齐逻辑保留兜底。 */
// V1.1.8：封面 URL 统一解析——https/data/blob 直接用；http（如 kwcdn.kuwo.cn，
// 其 https 证书无效）经主进程代理转 dataURL，否则被页面 CSP img-src 拦截不显示。
function resolveCoverSrc(url) {
  const u = String(url || '');
  if (/^https:\/\//i.test(u) || /^data:/i.test(u) || /^blob:/i.test(u)) return Promise.resolve(u);
  if (/^http:\/\//i.test(u) && window.mine.streamCoverProxy) {
    return window.mine.streamCoverProxy(u)
      .then(r => (r && r.url) || '')
      .catch(() => '');
  }
  return Promise.resolve('');
}

function updateRowCover(song) {
  const gi = streamState.results.indexOf(song);
  if (gi < 0) return;
  const row = document.querySelector(`.stream-row[data-gi="${gi}"]`);
  const img = row && row.querySelector('img');
  if (!img) return;
  resolveCoverSrc(song.cover).then((src) => {
    if (!src || !streamState.results.includes(song)) return;
    if (song.cover !== src) song.cover = src; // 记忆 dataURL，后续渲染直接可用
    img.src = src;
    img.style.visibility = '';
  });
}

async function prefetchCovers() {
  const pending = streamState.results.filter(s => !s.cover && !s._coverPending);
  if (!pending.length) return;
  pending.forEach(s => { s._coverPending = true; });
  let idx = 0;
  const worker = async () => {
    while (idx < pending.length) {
      const song = pending[idx++];
      try {
        const p = await window.mine.streamGetPic({ provider: song.provider, song });
        if (p && p.url) {
          song.cover = p.url;
          song._coverPending = false;
          updateRowCover(song);
        }
      } catch { }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

$s('#btn-stream-search').onclick = () => doSearch(true);
$s('#stream-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(true); });

/* ---------------- 结果渲染 ---------------- */
const TYPE_LABEL = { flac24bit: 'Hi-Res', flac: 'FLAC', '320k': '320K', '128k': '128K' };
const TYPE_FULL = { flac24bit: 'Hi-Res 24bit', flac: '无损 FLAC', '320k': '极高 320K', '128k': '标准 128K' };

function typesBadges(song) {
  if (!song.types || !song.types.length) return '';
  const items = song.types.map(t => {
    const hq = t.type === 'flac' || t.type === 'flac24bit';
    return `<span class="s-type${hq ? ' hq' : ''}" title="${t.size || ''}">${TYPE_LABEL[t.type] || t.type}</span>`;
  });
  return `<span class="s-types">${items.join('')}</span>`;
}

function renderResults() {
  const box = $s('#stream-list');
  box.innerHTML = '';
  const frag = document.createDocumentFragment();

  // —— 本地组（仅第一页置顶） ——
  if (streamState.kw && streamState.page <= 1) {
    const local = localMatches(streamState.kw);
    if (local.length) {
      const head = document.createElement('div');
      head.className = 'stream-group-head local';
      head.textContent = `本地曲库（${local.length}）`;
      frag.appendChild(head);
      local.forEach((m) => {
        const row = document.createElement('div');
        row.className = 'stream-row local-row';
        row.innerHTML = `
          <div class="s-texts">
            <div class="s-name">${escapeHtml(m.title)}${m.fav ? ' <span class="s-badge fav">♥ 已收藏</span>' : ''}</div>
            <div class="s-sub">${escapeHtml(m.artist)}${m.album ? ' · ' + escapeHtml(m.album) : ''}</div>
          </div>
          <span class="s-badge local">${escapeHtml(m.fmt)}</span>`;
        row.onclick = () => { state.queue = [m.track]; playAt(0); };
        frag.appendChild(row);
      });
    }
  }

  // —— 平台结果 ——
  const head = document.createElement('div');
  head.className = 'stream-group-head';
  head.textContent = `${PLATFORMS[streamState.provider]}（${streamState.results.length}）`;
  frag.appendChild(head);

  streamState.results.forEach((song, gi) => {
    const dup = localDupOf(song);
    const row = document.createElement('div');
    row.className = 'stream-row' + (gi === streamState.index ? ' active' : '');
    row.setAttribute('data-gi', gi);
    const dur = song.interval || (song.duration ? Math.floor(song.duration / 60000) + ':' + String(Math.floor(song.duration / 1000) % 60).padStart(2, '0') : '');
    // V1.1.8：http 封面（kwcdn.kuwo.cn 等）不直接内联——CSP img-src 只放行 https/data，
    // 渲染后统一经 resolveCoverSrc 代理转 dataURL 再显示
    const coverDirect = song.cover && /^(https|data|blob):/i.test(song.cover) ? song.cover : '';
    row.innerHTML = `
      ${coverDirect ? `<img src="${coverDirect}" loading="lazy" alt="" onerror="this.style.visibility='hidden'">` : '<img alt="" style="visibility:hidden">'}
      <div class="s-texts">
        <div class="s-name">${escapeHtml(song.name)}${dup ? `<span class="s-badge dup" title="${dup.lossless ? '曲库中已有无损版本' : '曲库中已有此曲'}">✔ ${dup.fav ? '已收藏' : dup.lossless ? '已有本地无损' : '已有本地'}</span>` : ''}</div>
        <div class="s-sub">${escapeHtml(song.artist || '未知艺人')}${song.album ? ' · ' + escapeHtml(song.album) : ''}${dur ? ' · ' + dur : ''}</div>
      </div>
      ${typesBadges(song)}
      <button class="s-dl" data-gi="${gi}" title="下载到本地曲库">⬇</button>`;
    row.onclick = () => playStreamAt(gi);
    const dlBtn = row.querySelector('.s-dl');
    dlBtn.onclick = (ev) => { ev.stopPropagation(); downloadStreamAt(gi, dlBtn); };
    frag.appendChild(row);
    // http 封面：渲染后异步代理补齐（不阻塞列表渲染）
    if (song.cover && !coverDirect) updateRowCover(song);
  });

  // —— 加载更多 ——
  if (streamState.kw && streamState.page < streamState.allPage && !streamState.searching) {
    const more = document.createElement('button');
    more.className = 'stream-more';
    more.textContent = `加载更多（${streamState.page}/${streamState.allPage}）`;
    more.onclick = () => doSearch(false);
    frag.appendChild(more);
  }

  box.appendChild(frag);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 播放 ---------------- */
// V1.1.4：流媒体快速切歌合并——150ms 窗口内连点累计目标，只执行最后一次（减少引擎设备开关）
const streamSwitch = { timer: 0, target: null };
function cancelStreamSwitch() {
  clearTimeout(streamSwitch.timer);
  streamSwitch.timer = 0;
  streamSwitch.target = null;
}
function queueStreamSwitch(dir) {
  const base = streamSwitch.target !== null ? streamSwitch.target : streamState.index;
  const max = streamState.results.length - 1;
  streamSwitch.target = Math.max(0, Math.min(max, base + dir));
  clearTimeout(streamSwitch.timer);
  streamSwitch.timer = setTimeout(() => {
    const t = streamSwitch.target;
    cancelStreamSwitch();
    if (streamState.results[t]) playStreamAt(t);
  }, 150);
}

// V1.1.4：播放中预取下一首播放地址 + 预热引擎 probe 缓存——切歌时跳过 songUrl 网络请求与
// 引擎 ffprobe 探测（流媒体切歌 3~5s → ~1s）
function prefetchNextSong() {
  const next = streamState.results[streamState.index + 1];
  if (!next || next._prefetched) return;
  next._prefetched = true;
  window.mine.streamSongUrl({ provider: next.provider, quality: currentQuality(), song: next })
    .then(r => {
      if (!r || !r.playable || !r.url) return;
      next._prefetchedUrl = r;
      // 预热引擎 probe 缓存（URL → TrackInfo），切歌时 Play 命中缓存跳过网络探测
      if (window.mine.engine) window.mine.engine('probe', { path: r.url }).catch(() => { });
    })
    .catch(() => { });
}

async function playStreamAt(i) {
  const song = streamState.results[i];
  if (!song) return;
  cancelStreamSwitch(); // 明确指定目标（点行/合并后执行），取消未执行的合并
  // V1.1.5：取消本地侧未执行的切歌合并——否则点流媒体曲目后 player.js 的 localSwitch
  // 定时器仍会开火，playAt 劫持播放（把刚播的流媒体换成本地曲目）
  if (typeof cancelLocalSwitch === 'function') cancelLocalSwitch();
  // V1.1.4：切歌清除 seek 保护（同 player.js）——否则新歌进度条被 seekPending 冻结 10 秒
  if (typeof state !== 'undefined' && state.seekPending) { state.seekPending = false; clearTimeout(state.seekTimer); }
  streamState.index = i;
  renderResults();
  const pname = PLATFORMS[song.provider] || song.provider;
  // V1.1.9：不再先发 engine('stop')——stop 会递增播放代际并停设备（设备开关）。
  // 直接让 annieStreamPlay 走 play.crossfade：引擎内 mixer FadeTo 旧曲淡出新曲淡入，
  // 设备保持打开（同采样率）；跨采样率时引擎自动回退快速播放（一次设备开关）。
  // 旧实现在等待 URL 期间旧曲会继续播（V1.1.4 曾用 stop 解决），但 stop 本身
  // 造成每次流媒体切歌都设备开关 + 打断 crossfade——得不偿失。
  setStreamStatus(`正在获取播放地址：${song.name}…`);

  let r, ly;
  const lyP = (window.mine.streamLyric
    ? window.mine.streamLyric({ provider: song.provider, song }).catch(() => null)
    : Promise.resolve(null));
  try {
    // V1.1.4：预取缓存命中时跳过 songUrl 网络请求（播放中已预取下一首）
    if (song._prefetchedUrl) {
      r = song._prefetchedUrl;
      song._prefetchedUrl = null;
    } else {
      r = await window.mine.streamSongUrl({
        provider: song.provider,
        quality: currentQuality(),
        song, // 完整歌曲对象（含 meta：洛雪音源脚本需要 hash/songmid 等原始字段）
      });
    }
    ly = await lyP;
  } catch (e) {
    setStreamStatus(`获取播放地址失败：${e.message || e}`, true);
    return;
  }
  if (streamState.index !== i) return; // 等待期间用户已点击其他曲目

  if (!r || !r.playable || !r.url) {
    setStreamStatus(`${song.name}：${(r && r.message) || '无法播放'}`, true);
    return;
  }

  const fmt = (r.format || '').toUpperCase();
  const downgradeNote = r.downgraded
    ? `（所选 ${TYPE_FULL[r.requestedType] || r.requestedType} 不可用，已降级为 ${TYPE_FULL[r.level] || r.level}）`
    : '';
  setStreamStatus(`${pname} · ${r.quality || ''} · ${fmt}${downgradeNote} · 独占输出中`, !!r.downgraded);
  // 歌词/封面注入通过 onPlayed 回调：playTrack（视觉切换）在 engine('play') 确认前
  // 同步执行完毕（player.js 已重排），此时注入 token 匹配、不会被 reset 覆盖，
  // 也不再被慢速网络流的引擎确认时间阻塞。
  const doInject = () => {
    if (streamState.index !== i) return; // 等待期间用户已点击其他曲目
    // 异步补齐封面（部分平台搜索结果不带图；拿到后除刷新列表外，还要推给舞台/悬浮封面）
    if (!song.cover && window.mine.streamGetPic) {
      window.mine.streamGetPic({ provider: song.provider, song }).then(p => {
        if (!p || !p.url) return;
        song.cover = p.url;
        if (streamState.results.includes(song)) renderResults();
        // 仍停留在该曲时，同步更新舞台封面（applyCoverCanvas 内部会连带刷新 thumb-cover）
        if (streamState.index === i && window.annieStage && window.annieStage.setCover) {
          window.annieStage.setCover(p.url);
        }
      }).catch(() => {});
    }
    // 注入歌词：与播放地址并行获取，playTrack 完成后立即渲染
    if (ly && ly.lrc && window.annieStage && window.annieStage.setLyricText) {
      window.annieStage.setLyricText(ly.lrc);
    }
    // V1.1.4：播放确认后预取下一首（URL 缓存 + 引擎 probe 预热）——切歌时秒起播
    prefetchNextSong();
  };
  if (window.annieStreamPlay) {
    window.annieStreamPlay({
      url: r.url,
      headers: r.headers || null,
      title: song.name,
      artist: song.artist,
      album: song.album || '',
      cover: song.cover || '',
      duration: song.duration ? song.duration / 1000 : 0,
      provider: song.provider,
      quality: r.quality || '',
      onPlayed: doInject,
    });
  } else {
    doInject();
  }
}

// 供 player.js 在曲目自然结束时调用
window.annieStream = {
  // V1.1.4：快速切歌合并（150ms 窗口连点只执行最后一次目标）——减少引擎设备开关
  playNext() {
    if (streamState.results.length && streamState.index < streamState.results.length - 1) {
      queueStreamSwitch(1);
    }
  },
  playPrev(positionSec) {
    // 播放超过 3 秒视为"想回到这首开头"（单次立即执行），否则切上一首（连点合并）
    if (streamSwitch.target === null && streamState.index > 0 && positionSec > 3) {
      playStreamAt(streamState.index);
    } else if (streamState.index > 0) {
      queueStreamSwitch(-1);
    } else if (streamState.results.length) {
      playStreamAt(0);
    }
  },
  currentFallbackDuration() {
    const s = streamState.results[streamState.index];
    return s && s.duration ? s.duration / 1000 : 0;
  },
};
window.annieStreamSearch = (kw) => {
  document.querySelector('.side-tab[data-tab="stream"]')?.click();
  $s('#stream-search').value = kw;
  doSearch(true);
};

/* ================= 洛雪式音源管理 ================= */
const sourceState = { list: [] };

async function refreshSources() {
  try {
    sourceState.list = await window.mine.streamSourcesList();
  } catch { sourceState.list = []; }
  renderSources();
}

function renderSources() {
  const box = $s('#source-list');
  const status = $s('#source-status');
  box.innerHTML = '';
  const active = sourceState.list.filter(s => s.enabled && s.loaded);
  if (!sourceState.list.length) {
    status.textContent = '未导入音源（使用内置解析）';
    status.classList.remove('active');
    return;
  }
  status.textContent = active.length
    ? `已启用 ${active.length} 个音源：${active.map(s => s.name).join('、')}`
    : '音源已全部停用（使用内置解析）';
  status.classList.toggle('active', active.length > 0);

  for (const s of sourceState.list) {
    const row = document.createElement('div');
    row.className = 'src-row';
    const title = `${s.name}${s.version ? ' v' + s.version : ''}${s.author ? ' by ' + s.author : ''}${s.description ? '\n' + s.description : ''}${s.enabled && !s.loaded ? '\n（加载失败，请重新导入）' : ''}`;
    row.innerHTML = `
      <div class="src-toggle${s.enabled ? ' on' : ''}" title="${s.enabled ? '点击停用' : '点击启用'}"></div>
      <div class="src-name" title="${escapeHtml(title)}">${escapeHtml(s.name)}</div>
      <span class="src-ver">${escapeHtml(s.version || '')}</span>
      <button class="src-del" title="删除音源">✕</button>`;
    row.querySelector('.src-toggle').onclick = async () => {
      try {
        await window.mine.streamSourcesSetEnabled({ id: s.id, enabled: !s.enabled });
      } catch (e) {
        setStreamStatus('启用音源失败：' + (e.message || e), true);
      }
      refreshSources();
    };
    row.querySelector('.src-del').onclick = async () => {
      if (!confirm(`删除音源「${s.name}」？`)) return;
      await window.mine.streamSourcesRemove({ id: s.id });
      refreshSources();
    };
    box.appendChild(row);
  }
}

$s('#btn-source-import').onclick = async () => {
  setStreamStatus('正在导入音源…');
  try {
    const r = await window.mine.streamSourcesImport();
    if (r.canceled) { setStreamStatus('已取消导入'); return; }
    if (r.error) { setStreamStatus('导入失败：' + r.error, true); return; }
    setStreamStatus(`音源「${r.source.name}」导入成功并已启用`);
    refreshSources();
  } catch (e) {
    setStreamStatus('导入失败：' + (e.message || e), true);
  }
};

/* ================= 流媒体下载 ================= */
const dlJobs = new Map();
let dlSeq = 0;

window.mine.onStreamDownloadProgress(({ key, received, total }) => {
  const job = dlJobs.get(key);
  if (!job) return;
  const pct = total ? Math.min(99, Math.round(received / total * 100)) : Math.round(received / 1024) + 'K';
  job.btn.textContent = total ? pct + '%' : String(pct);
});

async function downloadStreamAt(gi, btn) {
  const song = streamState.results[gi];
  if (!song || btn.classList.contains('busy')) return;
  const key = 'dl' + (++dlSeq);
  btn.classList.add('busy');
  btn.textContent = '…';
  dlJobs.set(key, { btn, name: song.name });
  setStreamStatus(`正在下载：${song.name}…`);
  try {
    const r = await window.mine.streamDownload({
      provider: song.provider,
      quality: currentQuality(),
      song,
      _dlKey: key,
      // V1.1.10：下载附加项开关（设置页"下载设置"卡片右下角）
      saveLrc: !window.annieSettings || annieSettings.ui.saveLrc !== false,
      saveCover: !window.annieSettings || annieSettings.ui.saveCover !== false,
    });
    dlJobs.delete(key);
    if (r && r.ok) {
      btn.classList.remove('busy');
      btn.classList.add('done');
      btn.textContent = '✔';
      const dlNote = r.downgraded ? `（${TYPE_FULL[r.requestedType] || r.requestedType} 不可用，已降级）` : '';
      setStreamStatus(`已下载：${song.name}（${(r.size / 1048576).toFixed(1)}MB · ${r.quality || ''}${dlNote}）→ ${r.path}`, !!r.downgraded);
    } else {
      btn.classList.remove('busy');
      btn.textContent = '⬇';
      setStreamStatus(`下载失败：${(r && r.error) || '未知错误'}`, true);
    }
  } catch (e) {
    dlJobs.delete(key);
    btn.classList.remove('busy');
    btn.textContent = '⬇';
    setStreamStatus('下载失败：' + (e.message || e), true);
  }
}

/* ================= 下载目录 ================= */
async function refreshDownloadDir() {
  try {
    const dir = await window.mine.streamDownloadDir();
    const el = $s('#dl-dir');
    el.textContent = '下载目录：' + dir;
    el.title = dir;
  } catch { }
}

$s('#btn-dl-dir').onclick = async () => {
  try {
    const r = await window.mine.streamSetDownloadDir();
    if (r.canceled) return;
    setStreamStatus('下载目录已更改为：' + r.dir);
    refreshDownloadDir();
  } catch (e) {
    setStreamStatus('更改下载目录失败：' + (e.message || e), true);
  }
};

$s('#btn-dl-dir-reset').onclick = async () => {
  try {
    const dir = await window.mine.streamResetDownloadDir();
    setStreamStatus('已恢复默认下载目录：' + dir);
    refreshDownloadDir();
  } catch { }
};

/* ================= 启动 ================= */
refreshSources();
refreshDownloadDir();

})();
