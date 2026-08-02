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
  } catch (e) {
    setStreamStatus('搜索失败：' + (e.message || e), true);
  } finally {
    streamState.searching = false;
  }
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
    const dur = song.interval || (song.duration ? Math.floor(song.duration / 60000) + ':' + String(Math.floor(song.duration / 1000) % 60).padStart(2, '0') : '');
    row.innerHTML = `
      ${song.cover ? `<img src="${song.cover}" loading="lazy" alt="" onerror="this.style.visibility='hidden'">` : '<img alt="" style="visibility:hidden">'}
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
async function playStreamAt(i) {
  const song = streamState.results[i];
  if (!song) return;
  streamState.index = i;
  renderResults();
  const pname = PLATFORMS[song.provider] || song.provider;
  setStreamStatus(`正在获取播放地址：${song.name}…`);

  let r;
  try {
    r = await window.mine.streamSongUrl({
      provider: song.provider,
      quality: currentQuality(),
      song, // 完整歌曲对象（含 meta：洛雪音源脚本需要 hash/songmid 等原始字段）
    });
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
    });
  }
  // 异步补齐封面（部分平台搜索结果不带图）
  if (!song.cover && window.mine.streamGetPic) {
    window.mine.streamGetPic({ provider: song.provider, song }).then(p => {
      if (p && p.url) { song.cover = p.url; if (streamState.results.includes(song)) renderResults(); }
    }).catch(() => {});
  }
}

// 供 player.js 在曲目自然结束时调用
window.annieStream = {
  playNext() {
    if (streamState.results.length && streamState.index < streamState.results.length - 1) {
      playStreamAt(streamState.index + 1);
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
