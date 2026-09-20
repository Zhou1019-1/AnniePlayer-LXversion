'use strict';
/* ============================================================================
 * 曲库标签编辑（V3.5.9）—— 全主题共用覆盖层弹窗
 *   - 编辑 标题/艺人/专辑/专辑艺术家 + 封面（本地选图）
 *   - 写回走主进程 tag:edit（ffmpeg 流复制不重编码；CUE/ISO 分轨不支持）
 *   - 附"在线匹配…"快捷入口（复用 V3.3.1 annieMatch，自动补全歌词/封面）
 *   - 对外：window.annieTagEdit.open({ path })
 * ========================================================================== */
(function () {
  var STYLE_ID = 'tag-editor-style';
  var win = null, coverFile = null, curPath = null;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.tged-mask{position:fixed;inset:0;z-index:9900;background:rgba(4,6,10,.55);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;animation:tgedIn .18s ease}',
      '@keyframes tgedIn{from{opacity:0}to{opacity:1}}',
      '.tged-win{width:560px;max-width:94vw;border-radius:18px;padding:22px 24px;background:rgba(22,24,32,.92);border:1px solid rgba(255,255,255,.1);box-shadow:0 24px 60px rgba(0,0,0,.5);color:#e8eaf0;font-size:13px}',
      '.tged-title{font-size:15px;font-weight:700;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center}',
      '.tged-close{background:none;border:none;color:rgba(255,255,255,.5);font-size:16px;cursor:pointer;padding:2px 6px;border-radius:6px}',
      '.tged-close:hover{color:#fff;background:rgba(255,255,255,.1)}',
      '.tged-row{display:flex;align-items:center;gap:10px;margin-bottom:10px;min-width:0}',
      '.tged-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px;min-width:0}',
      '.tged-grid .tged-row{min-width:0}',
      '.tged-comment{margin-top:2px}',
      '.tged-row label{width:70px;flex:none;color:rgba(255,255,255,.55);font-size:12px;text-align:right}',
      '.tged-row input[type=text]{flex:1;min-width:0;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#e8eaf0;padding:7px 10px;font-size:13px;outline:none}',
      '.tged-row input[type=text]:focus{border-color:rgba(212,162,74,.6)}',
      '.tged-cover{display:flex;gap:14px;align-items:center;margin:6px 0 14px}',
      '.tged-cover img{width:88px;height:88px;border-radius:10px;object-fit:cover;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1)}',
      '.tged-cover-btns{display:flex;flex-direction:column;gap:8px}',
      '.tged-btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#e8eaf0;border-radius:999px;padding:7px 16px;font-size:12.5px;cursor:pointer}',
      '.tged-btn:hover{background:rgba(255,255,255,.14)}',
      '.tged-btn:disabled{opacity:.5;cursor:default}',
      '.tged-btn-accent{background:linear-gradient(135deg,#d4a24a,#b4812e);border-color:transparent;color:#1a1206;font-weight:600}',
      '.tged-btn-accent:hover{filter:brightness(1.08)}',
      '.tged-foot{display:flex;justify-content:space-between;align-items:center;margin-top:8px}',
      '.tged-status{font-size:11.5px;color:rgba(255,255,255,.5);min-height:14px}',
      '.tged-status.err{color:#ff8080}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function toast(msg, ms) {
    try { if (typeof proToast === 'function') { proToast(msg, ms); return; } } catch (e) { }
    var st = win && win.querySelector('.tged-status');
    if (st) { st.textContent = msg; st.classList.toggle('err', /失败|不支持/.test(msg)); }
  }

  function open(opts) {
    ensureStyle();
    close();
    curPath = opts.path;
    coverFile = null;

    var mask = document.createElement('div');
    mask.className = 'tged-mask';
    win = document.createElement('div');
    win.className = 'tged-win';
    win.innerHTML =
      '<div class="tged-title"><span>编辑标签</span><button class="tged-close">✕</button></div>' +
      '<div class="tged-grid">' +
      '<div class="tged-row"><label>标题</label><input type="text" data-k="title"></div>' +
      '<div class="tged-row"><label>艺人</label><input type="text" data-k="artist"></div>' +
      '<div class="tged-row"><label>专辑</label><input type="text" data-k="album"></div>' +
      '<div class="tged-row"><label>专辑艺术家</label><input type="text" data-k="albumArtist"></div>' +
      '<div class="tged-row"><label>流派</label><input type="text" data-k="genre"></div>' +
      '<div class="tged-row"><label>年份</label><input type="text" data-k="date" placeholder="如 2024"></div>' +
      '<div class="tged-row"><label>曲目号</label><input type="text" data-k="track" placeholder="如 3 或 3/12"></div>' +
      '<div class="tged-row"><label>碟号</label><input type="text" data-k="disc" placeholder="如 1 或 1/2"></div>' +
      '<div class="tged-row"><label>作曲家</label><input type="text" data-k="composer"></div>' +
      '<div class="tged-row"><label>发行方</label><input type="text" data-k="publisher"></div>' +
      '</div>' +
      '<div class="tged-row tged-comment"><label>注释</label><input type="text" data-k="comment"></div>' +
      '<div class="tged-cover"><img alt=""><div class="tged-cover-btns">' +
      '<button class="tged-btn" data-act="pick">选择封面图…</button>' +
      (window.annieMatch ? '<button class="tged-btn" data-act="match">在线匹配歌词 / 封面…</button>' : '') +
      '</div></div>' +
      '<div class="tged-foot"><span class="tged-status">留空的字段将从文件中删除该标签</span>' +
      '<span style="display:flex;gap:10px"><button class="tged-btn" data-act="cancel">取消</button>' +
      '<button class="tged-btn tged-btn-accent" data-act="save">保存</button></span></div>';
    mask.appendChild(win);
    document.body.appendChild(mask);

    mask.addEventListener('pointerdown', function (e) { if (e.target === mask) close(); });
    win.querySelector('.tged-close').onclick = close;
    win.querySelector('[data-act=cancel]').onclick = close;
    win.querySelector('[data-act=pick]').onclick = async function () {
      var f = await window.mine.tagPickCover().catch(function () { return null; });
      if (!f) return;
      coverFile = f;
      // 本地预览（CSP 允许 data: 与本机 file 经 img 不行——读成 dataURL 太浪费，直接 file:// 预览）
      win.querySelector('.tged-cover img').src = 'file:///' + f.replace(/\\/g, '/');
      toast('已选择封面，保存后写入文件标签');
    };
    var matchBtn = win.querySelector('[data-act=match]');
    if (matchBtn) matchBtn.onclick = function () { close(); window.annieMatch.open({ path: curPath }); };
    win.querySelector('[data-act=save]').onclick = save;

    // 载入现有标签
    window.mine.meta(curPath).then(function (m) {
      if (!win || !m) return;
      ['title', 'artist', 'album', 'albumArtist', 'genre', 'track', 'disc', 'composer', 'publisher', 'comment'].forEach(function (k) {
        var inp = win.querySelector('[data-k=' + k + ']');
        if (inp && m[k]) inp.value = m[k];
      });
      if (m.year) win.querySelector('[data-k=date]').value = m.year;
      if (m.cover) win.querySelector('.tged-cover img').src = m.cover;
    }).catch(function () { });
  }

  async function save() {
    if (!win) return;
    var btn = win.querySelector('[data-act=save]');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      var r = await window.mine.tagEdit({
        path: curPath,
        title: win.querySelector('[data-k=title]').value,
        artist: win.querySelector('[data-k=artist]').value,
        album: win.querySelector('[data-k=album]').value,
        albumArtist: win.querySelector('[data-k=albumArtist]').value,
        genre: win.querySelector('[data-k=genre]').value,
        date: win.querySelector('[data-k=date]').value,
        track: win.querySelector('[data-k=track]').value,
        disc: win.querySelector('[data-k=disc]').value,
        composer: win.querySelector('[data-k=composer]').value,
        publisher: win.querySelector('[data-k=publisher]').value,
        comment: win.querySelector('[data-k=comment]').value,
        coverFile: coverFile,
      });
      if (r && r.ok) {
        // 刷新渲染侧缓存与列表
        try {
          if (typeof state !== 'undefined' && state.metaCache) state.metaCache.delete(curPath);
          if (typeof renderCurrentView === 'function') renderCurrentView();
          if (typeof renderFolderTree === 'function') renderFolderTree();
          document.dispatchEvent(new CustomEvent('annie-tag-edited', { detail: { path: curPath } }));
        } catch (e) { }
        close();
        toast('标签已保存');
      } else {
        toast('保存失败：' + ((r && r.reason) || '未知错误'), 5000);
        btn.disabled = false; btn.textContent = '保存';
      }
    } catch (e) {
      toast('保存失败：' + (e && e.message ? e.message : e), 5000);
      btn.disabled = false; btn.textContent = '保存';
    }
  }

  function close() {
    if (win && win.parentNode) win.parentNode.remove();
    win = null; coverFile = null; curPath = null;
  }

  window.annieTagEdit = { open: open, close: close };
})();
