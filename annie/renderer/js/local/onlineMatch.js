'use strict';
/* ============================================================================
 * 在线歌词 / 封面匹配（一期：单曲手动匹配弹窗，三主题通用）
 *   入口：FB2K 行右键菜单 / AM 行 ⋯ 菜单 → window.annieMatch.open({ path })
 *   流程：matchSearch 拿候选（五平台 + 匹配度打分）→ 用户选定 → matchApply 落盘
 *   落盘约定：歌词 = 旁挂同名 .lrc；封面 = 目录 cover.jpg（专辑共享，可选覆盖）；
 *             可选同时嵌入文件标签（ffmpeg remux，仅补歌词/封面不动其他标签）。
 * ========================================================================== */
(function () {
  var overlay = null; // 单例弹窗
  var cur = null;     // 当前会话 { path, local, candidates }

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }
  function fmtDur(ms) {
    if (!ms) return '--:--';
    var s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function close() { if (overlay) { overlay.remove(); overlay = null; cur = null; } }

  function open(opts) {
    if (!opts || !opts.path) return;
    if (opts.path.indexOf('#') >= 0) {
      toast('CUE/ISO 分轨暂不支持在线匹配'); return;
    }
    close();
    overlay = el('div', 'match-overlay');
    overlay.onmousedown = function (e) { if (e.target === overlay) close(); };

    var dlg = el('div', 'match-dialog');
    // 头部
    var head = el('div', 'match-head');
    head.appendChild(el('div', 'match-title', '在线匹配歌词 / 封面'));
    var bClose = el('button', 'match-x', '✕');
    bClose.onclick = close;
    head.appendChild(bClose);
    dlg.appendChild(head);

    // 本地信息
    var localBox = el('div', 'match-local', '读取本地标签中…');
    dlg.appendChild(localBox);

    // 搜索行
    var sRow = el('div', 'match-searchrow');
    var kwIn = document.createElement('input');
    kwIn.className = 'match-kw'; kwIn.placeholder = '搜索关键词（默认：标题 + 艺人）';
    var bSearch = el('button', 'match-btn', '搜索');
    sRow.appendChild(kwIn); sRow.appendChild(bSearch);
    dlg.appendChild(sRow);

    // 选项行（歌词/封面/嵌入的默认勾选读设置中心·歌词页的保存项配置）
    var defOf = function (k, d) { try { var v = localStorage.getItem('annieplayer.match.def.' + k); return v === null ? d : v !== '0'; } catch (e) { return d; } };
    var oRow = el('div', 'match-opts');
    var ckLrc = mkCheck(oRow, '保存歌词（旁挂 .lrc）', defOf('lrc', true));
    var ckCover = mkCheck(oRow, '保存封面（cover.jpg）', defOf('cover', true));
    var ckOverwrite = mkCheck(oRow, '覆盖已有封面', false);
    var ckEmbed = mkCheck(oRow, '同时嵌入文件标签', defOf('embed', false));
    dlg.appendChild(oRow);

    // 候选列表 + 状态行
    var list = el('div', 'match-list');
    dlg.appendChild(list);
    var status = el('div', 'match-status', '');
    dlg.appendChild(status);

    overlay.appendChild(dlg);
    document.body.appendChild(overlay);

    function mkCheck(parent, label, checked) {
      var lb = el('label', 'match-ck');
      var c = document.createElement('input');
      c.type = 'checkbox'; c.checked = checked;
      lb.appendChild(c); lb.appendChild(document.createTextNode(label));
      parent.appendChild(lb);
      return c;
    }

    function renderLocal(local) {
      localBox.innerHTML = '';
      localBox.appendChild(el('div', 'match-local-t', local.title || '（无标题标签）'));
      localBox.appendChild(el('div', 'match-local-s',
        (local.artist || '未知艺人') + (local.album ? ' — ' + local.album : '') + ' · ' + fmtDur(local.duration)));
    }

    function renderList(cands) {
      list.innerHTML = '';
      if (!cands.length) { list.appendChild(el('div', 'match-empty', '五平台均无结果，试试修改关键词')); return; }
      cands.forEach(function (c) {
        var row = el('div', 'match-row');
        var img = document.createElement('img');
        img.className = 'match-cover'; img.alt = ''; img.draggable = false;
        if (c.cover) img.src = c.cover;
        row.appendChild(img);
        var tx = el('div', 'match-tx');
        tx.appendChild(el('div', 'match-name', c.name));
        tx.appendChild(el('div', 'match-sub', (c.artist || '未知艺人') + (c.album ? ' — ' + c.album : '')));
        var meta = el('div', 'match-meta');
        meta.appendChild(el('span', 'match-badge', c.providerLabel));
        meta.appendChild(el('span', null, fmtDur(c.duration)));
        var sc = el('span', 'match-score' + (c.score >= 80 ? ' high' : ''), '匹配 ' + c.score + '%');
        meta.appendChild(sc);
        tx.appendChild(meta);
        row.appendChild(tx);
        var bApply = el('button', 'match-btn match-apply', '应用');
        bApply.onclick = function () { doApply(c, bApply); };
        row.appendChild(bApply);
        list.appendChild(row);
      });
    }

    function doSearch() {
      status.textContent = '搜索中（五平台并行）…';
      list.innerHTML = '';
      window.mine.matchSearch({ path: cur.path, keyword: kwIn.value }).then(function (r) {
        if (!overlay) return;
        if (!r || !r.ok) { status.textContent = (r && r.reason) || '搜索失败'; return; }
        cur.local = r.local;
        renderLocal(r.local);
        if (!kwIn.value.trim()) kwIn.value = r.keyword;
        status.textContent = '候选 ' + r.candidates.length + ' 条（按匹配度排序）';
        renderList(r.candidates);
      }).catch(function (e) { if (overlay) status.textContent = '搜索失败：' + (e && e.message || e); });
    }

    function doApply(c, btn) {
      if (!ckLrc.checked && !ckCover.checked && !ckEmbed.checked) { status.textContent = '请至少勾选一个保存项'; return; }
      btn.disabled = true; btn.textContent = '…';
      status.textContent = '正在保存：' + c.name + '（' + c.providerLabel + '）…';
      window.mine.matchApply({
        path: cur.path, provider: c.provider, song: c.song,
        saveLrc: ckLrc.checked, saveCover: ckCover.checked,
        embed: ckEmbed.checked, overwriteCover: ckOverwrite.checked,
      }).then(function (r) {
        btn.disabled = false; btn.textContent = '应用';
        if (!overlay) return;
        if (!r || !r.ok) { status.textContent = (r && r.reason) || '保存失败'; return; }
        var parts = [];
        if (r.lrc) parts.push('歌词已存 .lrc');
        if (r.cover) parts.push('封面已存 cover 文件');
        if (r.embedded) parts.push('已嵌入文件标签');
        (r.notes || []).forEach(function (n) { parts.push(n); });
        status.textContent = parts.join('；') || '完成';
        toast(parts.join('；') || '匹配完成');
        // 通知各主题刷新（若正在播放该文件：重载歌词/封面）
        try { document.dispatchEvent(new CustomEvent('annie-local-media-updated', { detail: { path: cur.path } })); } catch (e) { }
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = '应用';
        if (overlay) status.textContent = '保存失败：' + (e && e.message || e);
      });
    }

    bSearch.onclick = doSearch;
    kwIn.onkeydown = function (e) { if (e.key === 'Enter') doSearch(); };
    cur = { path: opts.path };
    doSearch(); // 打开即自动搜索
  }

  function toast(msg) { try { if (typeof proToast === 'function') proToast(msg); } catch (e) { } }

  /* ==========================================================================
   * 批量匹配歌词（V4.3.4）：整个曲库 / 文件夹 / FB2K 多选 → window.annieBatchMatch.open(paths)
   *   ≥80% 自动落盘旁挂 .lrc（含翻译行）；失败/跳过原因列在弹窗底部；可取消。
   * ======================================================================== */
  var bmOverlay = null, bmOff = null, bmRunning = false;

  function bmClose() {
    if (bmRunning) { try { window.mine.matchBatchCancel(); } catch (e) { } }
    if (bmOff) { bmOff(); bmOff = null; }
    if (bmOverlay) { bmOverlay.remove(); bmOverlay = null; }
    bmRunning = false;
  }

  function bmOpen(paths) {
    paths = (paths || []).filter(function (p) { return p && p.indexOf('#') < 0; });
    if (!paths.length) { toast('没有可匹配的曲目'); return; }
    bmClose();
    bmOverlay = el('div', 'match-overlay');
    var dlg = el('div', 'match-dialog');

    var head = el('div', 'match-head');
    head.appendChild(el('div', 'match-title', '批量匹配歌词'));
    var bX = el('button', 'match-x', '✕');
    bX.onclick = bmClose;
    head.appendChild(bX);
    dlg.appendChild(head);

    dlg.appendChild(el('div', 'match-local-s',
      '共 ' + paths.length + ' 首 · 五平台搜索取最高分，匹配度 ≥80% 自动保存旁挂 .lrc（含翻译行）；不足的列入下方清单'));

    var oRow = el('div', 'match-opts');
    var ckOver = (function () {
      var lb = el('label', 'match-ck');
      var c = document.createElement('input'); c.type = 'checkbox';
      lb.appendChild(c); lb.appendChild(document.createTextNode('覆盖已有歌词（.lrc）'));
      oRow.appendChild(lb); return c;
    })();
    dlg.appendChild(oRow);

    var bar = el('div', 'bm-bar'); var barI = el('div', 'bm-bar-i'); bar.appendChild(barI);
    dlg.appendChild(bar);
    var status = el('div', 'match-status', '就绪');
    dlg.appendChild(status);
    var failList = el('div', 'bm-fail-list');
    dlg.appendChild(failList);

    var btnRow = el('div', 'match-searchrow');
    var bGo = el('button', 'match-btn match-apply', '开始匹配');
    btnRow.appendChild(bGo);
    dlg.appendChild(btnRow);

    bmOverlay.appendChild(dlg);
    document.body.appendChild(bmOverlay);

    function addFail(p, note) {
      var row = el('div', 'bm-fail-row');
      row.appendChild(el('div', 'bm-fail-p', p));
      row.appendChild(el('div', 'bm-fail-n', note || ''));
      failList.appendChild(row);
      failList.scrollTop = failList.scrollHeight;
    }

    bGo.onclick = function () {
      if (bmRunning) { window.mine.matchBatchCancel(); bGo.disabled = true; bGo.textContent = '取消中…'; return; }
      bmRunning = true;
      ckOver.disabled = true;
      bGo.textContent = '取消';
      failList.innerHTML = '';
      window.mine.matchBatchStart(paths, { overwrite: ckOver.checked }).then(function (r) {
        if (r && !r.ok) { status.textContent = r.reason || '启动失败'; bmRunning = false; bGo.textContent = '开始匹配'; ckOver.disabled = false; }
      }).catch(function () { });
      bmOff = window.mine.onMatchBatchEvent(function (ev) {
        if (!bmOverlay) { if (bmOff) { bmOff(); bmOff = null; } return; }
        if (ev.type === 'progress') {
          barI.style.width = Math.round(ev.done / ev.total * 100) + '%';
          status.textContent = '匹配中 ' + ev.done + '/' + ev.total + ' · 成功 ' + ev.matched + ' · 跳过 ' + ev.skipped + ' · 未匹配 ' + ev.failed;
          if (ev.result === 'failed') addFail(ev.path, ev.note);
          else if (ev.result === 'matched') {
            // 正在播放该文件时重载歌词（与单曲匹配同一通知）
            try { document.dispatchEvent(new CustomEvent('annie-local-media-updated', { detail: { path: ev.path } })); } catch (e) { }
          }
        } else if (ev.type === 'end') {
          bmRunning = false;
          if (bmOff) { bmOff(); bmOff = null; }
          barI.style.width = Math.round(ev.done / ev.total * 100) + '%';
          bGo.textContent = '完成'; bGo.disabled = true;
          ckOver.disabled = false;
          status.textContent = (ev.canceled ? '已取消：' : '完成：') + '成功 ' + ev.matched + ' 首 · 跳过 ' + ev.skipped + ' · 未匹配 ' + ev.failed + '（共 ' + ev.total + ' 首）';
          toast(status.textContent);
        }
      });
    };
  }

  window.annieMatch = { open: open, close: close };
  window.annieBatchMatch = { open: bmOpen, close: bmClose };
})();
