'use strict';
/* V4.3.22：AM「下载情况」视图——洛雪式下载任务管理
 * 五个标签（所有任务/正在下载/已暂停/出错/下载完成）+ 任务表格（#/歌曲名/进度/状态/品质/操作）
 * 数据源：主进程 dlManager（dl-tasks.json 持久化）；'dl:event' 事件实时刷新 */
(function () {
  var AM = window.__annieAMInternal;
  if (!AM) return;
  var S = AM.S;
  function el(c, h) { return AM.el.apply(AM, arguments); }
  function renderView() { return AM.renderView.apply(this, arguments); }
  function esc(s) { return AM.esc ? AM.esc(s) : String(s == null ? '' : s); }

  var TAB_DEF = [['all', '所有任务'], ['downloading', '正在下载'], ['paused', '已暂停'], ['error', '出错'], ['done', '下载完成']];
  var STATUS_TXT = { waiting: '排队等待', downloading: '下载中…', paused: '已暂停', error: '出错', done: '下载完成' };
  var QLABEL = { '128k': '128K', '320k': '320K', flac: 'FLAC', flac24bit: 'Hi-Res', master: 'Master', hires: 'Hi-Res' };

  var dlTasks = [];
  var dlTab = 'all';
  var bound = false;

  function toast(msg) { try { if (typeof proToast === 'function') proToast(msg); } catch (e) { } }

  /* 事件订阅（一次性）：tasks 全量刷新视图；progress 原地更新进度条（不重绘表格，防闪烁/失焦）
   *
   * ⚠️ 2026-10-23 关键修复「下载没有实时进度及进度事件不生效」：
   *   后端 DownloadQueue.emit() / updateProgress() 是通过
   *     evaluateJavaScript("window.__amDlEvent && window.__amDlEvent(...)")
   *   推事件的，但本文件**从来没有定义过 window.__amDlEvent** ——
   *   于是所有推送都被 `&&` 短路掉，一个都到不了前端：
   *     · 下载进度条永远停在 0%
   *     · 任务状态变化（开始/完成/出错）也不刷新，除非手动切页面
   *   修复：把事件处理器定义成全局函数 window.__amDlEvent，
   *        后端 evaluateJavaScript 才能打到它。
   *        （window.mine.onDlEvent 那条注册路径从未实现过，改用它已经没有意义）
   */
  // 暴露给 index.html 的 __amDlEvent 转发（避免两处定义格式打架）
  window.__amDlHandle = handleDlEvent;

  // ⚠️ 2026-10-23 修复「重新下载完成后资料库看不到新歌」：
  //   后端 DownloadQueue 完成时会 addTrack 入库，但前端 state.library 是缓存的旧数据，
  //   handleDlEvent 只刷新了下载页 → 曲库列表里永远看不到刚下载/重新下载的歌。
  //   现在检测到「完成任务数增加」就重新拉取曲库并重绘。
  function refreshLibraryAfterDownload() {
    if (!window.mine || !window.mine.getLibrary) return;
    window.mine.getLibrary().then(function (lib) {
      if (!lib) return;
      try { if (window.state) window.state.library = lib; } catch (e0) { }
      try { if (typeof window.rebuildLibIndex === 'function') window.rebuildLibIndex(); } catch (e1) { }
      try { if (typeof window.renderCurrentView === 'function') window.renderCurrentView(); } catch (e2) { }
      try {
        if (window.__annieAMInternal && window.__annieAMInternal.refreshPlaylists)
          window.__annieAMInternal.refreshPlaylists();
      } catch (e3) { }
    }).catch(function () { });
  }

  function handleDlEvent(ev) {
    if (!ev) return;
    if (ev.type === 'tasks') {
      var prevDone = (dlTasks || []).filter(function (x) { return x.status === 'done'; }).length;
      dlTasks = ev.tasks || [];
      if (S.view === 'downloads') renderView();
      var nowDone = dlTasks.filter(function (x) { return x.status === 'done'; }).length;
      // 有新完成的下载（含「重新下载」）→ 刷新资料库
      if (nowDone > prevDone) refreshLibraryAfterDownload();
    } else if (ev.type === 'progress') {
      var t = null;
      for (var i = 0; i < dlTasks.length; i++) {
        if (dlTasks[i].id === ev.id) { t = dlTasks[i]; break; }
      }
      if (t) { t.received = ev.received; t.total = ev.total; }
      if (S.view === 'downloads') updateProgress(ev);
    }
  }

  function bindEvents() {
    if (bound) return;
    bound = true;
    // 后端推送落点（必须挂在 window 上）
    window.__amDlEvent = handleDlEvent;
    // 首次拉取任务列表（后端推送可能早于页面加载）
    if (!window.mine || !window.mine.dlList) return;
    window.mine.dlList().then(function (l) {
      dlTasks = l || [];
      if (S.view === 'downloads') renderView();
    }).catch(function () { });
  }

  function pctOf(t) {
    if (t.status === 'done') return 100;
    if (!t.total) return 0;
    return Math.min(100, Math.floor(t.received / t.total * 100));
  }

  /* 进度文案：总量已知时「42%」，未知时「5.2M」；两者都带已下载量提示 */
  function fmtMB(bytes) {
    if (!bytes || bytes < 0) return '0M';
    var mb = bytes / 1048576;
    return mb >= 100 ? Math.round(mb) + 'M' : mb.toFixed(1) + 'M';
  }
  function pctText(received, total, status) {
    if (status === 'done') return '100%';
    if (total > 0) return Math.min(100, Math.floor(received / total * 100)) + '%';
    return fmtMB(received);   // 总量未知 → 显示已下载量（让用户知道在动）
  }
  function updateProgress(ev) {
    var pct = ev.total ? Math.min(100, Math.floor(ev.received / ev.total * 100)) : 0;
    var fill = document.querySelector('[data-dlprog="' + ev.id + '"]');
    if (fill) {
      // 总量未知时用「不确定进度条」动画（不会假装 0% 死掉）
      if (ev.total > 0) fill.style.width = pct + '%';
      else fill.style.width = '100%';
      fill.classList.toggle('indet', !(ev.total > 0));
    }
    var lab = document.querySelector('[data-dlpct="' + ev.id + '"]');
    if (lab) lab.textContent = ev.total > 0
      ? Math.min(100, Math.floor(ev.received / ev.total * 100)) + '%'
      : fmtMB(ev.received);
    // hover 提示已下载/总量
    if (lab && ev.total > 0) lab.title = fmtMB(ev.received) + ' / ' + fmtMB(ev.total);
  }

  function statusText(t) {
    if (t.status === 'error') return t.error || '下载失败';
    if (t.status === 'done' && t.note) return '下载完成（' + t.note + '）';
    return STATUS_TXT[t.status] || t.status;
  }

  function opBtn(txt, title, fn) {
    var b = el('button', 'am-dl-btn', txt);
    b.title = title;
    b.onclick = function (e) { e.stopPropagation(); fn(); };
    return b;
  }

  function renderDlView(c) {
    bindEvents();
    c.appendChild(el('div', 'am-view-h', '下载'));

    // 标签栏 + 标签级操作
    var bar = el('div', 'am-dlt-bar');
    var tabs = el('div', 'am-dlt-tabs');
    TAB_DEF.forEach(function (td) {
      var n = td[0] === 'all' ? dlTasks.length : dlTasks.filter(function (t) { return t.status === td[0]; }).length;
      var chip = el('button', 'am-chip' + (dlTab === td[0] ? ' cur' : ''), td[1] + (n ? ' ' + n : ''));
      chip.onclick = function () { dlTab = td[0]; renderView(); };
      tabs.appendChild(chip);
    });
    bar.appendChild(tabs);
    if (dlTab === 'done' && dlTasks.some(function (t) { return t.status === 'done'; })) {
      var bc = el('button', 'am-btn', '清空已完成');
      bc.onclick = function () { window.mine.dlClear(['done']); };
      bar.appendChild(bc);
    }
    if (dlTab === 'error' && dlTasks.some(function (t) { return t.status === 'error'; })) {
      var br = el('button', 'am-btn', '一键重试');
      br.onclick = function () {
        window.mine.dlRetryAll().then(function (n) {
          toast('已重新排队 ' + (n || 0) + ' 个任务');
          setTimeout(function () {
            window.mine.dlList().then(function (l2) {
              var still = (l2 || []).filter(function (x) { return x.status === 'error'; }).length;
              if (still > 0) toast('仍有 ' + still + ' 个任务失败，点的可能是酷狗接口（当前不可用）');
            }).catch(function () { });
          }, 1500);
        });
      };
      bar.appendChild(br);
    }
    c.appendChild(bar);

    var list = dlTab === 'all' ? dlTasks : dlTasks.filter(function (t) { return t.status === dlTab; });
    if (!list.length) {
      c.appendChild(el('div', 'am-dlt-empty', dlTasks.length ? '此标签下没有任务' : '列表竟然是空的…'));
      return;
    }

    var tb = el('table', 'am-table am-dlt-table');
    // ⚠️ 2026-10-23：表头不再写 inline width —— 否则会和 .am-dlt-table 的
    //    CSS 列宽打架（th 用 inline px、td 用 CSS 百分比 → 列错位）。
    //    列宽统一交给 am.css 里的 .am-dlt-table 规则。
    tb.innerHTML = '<thead><tr><th>#</th><th></th><th>歌曲名</th>' +
      '<th>进度</th><th>状态</th><th>品质</th><th>操作</th></tr></thead>';
    var body = el('tbody');
    list.forEach(function (t, i) {
      var tr = el('tr', 'am-tr');
      var tdN = el('td', 'am-c-dim', String(i + 1)); tdN.style.textAlign = 'center';
      tr.appendChild(tdN);
      // 封面（2026-10-23 新增：用户反馈下载页看不到封面）
      var tdCover = el('td', 'am-track-covercell');
      var img = document.createElement('img');
      img.className = 'am-c-cover';
      img.alt = '';
      img.loading = 'lazy';
      if (t.cover) {
        img.src = t.cover;
        img.onerror = function () { img.style.visibility = 'hidden'; };
      } else {
        img.style.visibility = 'hidden';
      }
      tdCover.appendChild(img);
      tr.appendChild(tdCover);
      var tdName = el('td', 'am-c-title');
      tdName.appendChild(el('div', 'am-dlt-name', esc(t.name || '未知')));
      tdName.appendChild(el('div', 'am-dlt-sub', esc((t.artist || '未知艺人') + (t.album ? ' · ' + t.album : ''))));
      tr.appendChild(tdName);
      // 进度条
      var tdP = el('td');
      var wrap = el('div', 'am-dlt-prog');
      var track = el('div', 'am-dlt-prog-track');
      var fill = el('div', 'am-dlt-prog-fill');
      fill.dataset.dlprog = t.id;
      fill.style.width = pctOf(t) + '%';
      track.appendChild(fill);
      // 进度数字：完成→100%，有总量→百分比，无总量→已下载量（至少让人知道在动）
      var pct = el('span', 'am-dlt-pct',
        t.status === 'done' ? '100%'
          : (t.total ? pctOf(t) + '%' : (t.received ? fmtMB(t.received) : '—')));
      pct.dataset.dlpct = t.id;
      wrap.appendChild(track); wrap.appendChild(pct);
      tdP.appendChild(wrap);
      tr.appendChild(tdP);
      // 状态（出错红字）
      var tdS = el('td', t.status === 'error' ? 'am-dlt-err' : 'am-c-dim', esc(statusText(t)));
      tdS.title = statusText(t);
      tr.appendChild(tdS);
      // 品质
      var qlab = QLABEL[t.quality] || (t.quality || '—').toUpperCase();
      var tdQ = el('td');
      // ⚠️ 2026-10-23：alac 也是无损，和 flac 一样用红色高亮徽标
      var _hqQ = (t.quality || '').toLowerCase();
      var qb = el('span', 'am-qbadge' + ((_hqQ === 'flac' || _hqQ === 'flac24bit' || _hqQ === 'master'
        || _hqQ === 'hires' || _hqQ === 'alac' || _hqQ === 'lossless') ? ' hq' : ''), qlab);
      tdQ.appendChild(qb);
      tr.appendChild(tdQ);
      // 操作
      var tdO = el('td');
      var ops = el('div', 'am-dlt-ops');
      if (t.status === 'downloading' || t.status === 'waiting') ops.appendChild(opBtn('⏸', '暂停', function () { window.mine.dlPause(t.id); }));
      if (t.status === 'paused') ops.appendChild(opBtn('▶', '继续', function () { window.mine.dlResume(t.id); }));
      if (t.status === 'error') ops.appendChild(opBtn('🔁', '重试', function () {
        // ⚠️ 2026-10-23：重试后要立刻给反馈，否则「点了没反应」——
        //    尤其是酷狗这类接口挂了的平台，重试=瞬间再失败，用户会以为按钮坏了。
        toast('已重新排队：' + (t.name || ''));
        window.mine.dlResume(t.id).then(function () {
          // 300ms 后看结果：又变回 error 就说明还是失败原因
          setTimeout(function () {
            window.mine.dlList().then(function (l2) {
              var t2 = (l2 || []).find(function (x) { return x.id === t.id; });
              if (t2 && t2.status === 'error') {
                toast('重试仍失败：' + (t2.error || '未知原因'));
              }
            }).catch(function () { });
          }, 1200);
        }).catch(function (e) { toast('重试失败：' + (e.message || e)); });
      }));
      if (t.status === 'done') ops.appendChild(opBtn('📂', '打开所在文件夹', function () { window.mine.dlOpenFolder(t.id); }));
      ops.appendChild(opBtn('✕', '移除任务', function () { window.mine.dlRemove(t.id); }));
      tdO.appendChild(ops);
      tr.appendChild(tdO);
      body.appendChild(tr);
    });
    tb.appendChild(body);
    c.appendChild(tb);
    // 新任务从顶部来？——与洛雪一致：追加在尾部，队列顺序即下载顺序
  }

  // ⚠️ 2026-10-23：模块加载时立刻绑定事件接收器 —— 下载可能在用户还没打开
  //    「下载」页时就开始（后台任务），提前绑定才能收到进度和状态变化。
  bindEvents();

  window.annieAMDownload = { render: renderDlView };
})();
