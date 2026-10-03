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

  /* 事件订阅（一次性）：tasks 全量刷新视图；progress 原地更新进度条（不重绘表格，防闪烁/失焦） */
  function bindEvents() {
    if (bound || !window.mine || !window.mine.onDlEvent) return;
    bound = true;
    window.mine.onDlEvent(function (ev) {
      if (!ev) return;
      if (ev.type === 'tasks') {
        dlTasks = ev.tasks || [];
        if (S.view === 'downloads') renderView();
      } else if (ev.type === 'progress') {
        var t = dlTasks.find(function (x) { return x.id === ev.id; });
        if (t) { t.received = ev.received; t.total = ev.total; }
        if (S.view === 'downloads') updateProgress(ev);
      }
    });
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

  function updateProgress(ev) {
    var fill = document.querySelector('[data-dlprog="' + ev.id + '"]');
    if (fill) fill.style.width = (ev.total ? Math.min(100, Math.floor(ev.received / ev.total * 100)) : 0) + '%';
    var lab = document.querySelector('[data-dlpct="' + ev.id + '"]');
    if (lab) lab.textContent = ev.total ? (Math.min(100, Math.floor(ev.received / ev.total * 100)) + '%') : (Math.floor(ev.received / 1048576) + 'M');
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
    c.appendChild(el('div', 'am-view-h', '下载情况'));

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
      br.onclick = function () { window.mine.dlRetryAll().then(function (n) { if (n) toast('已重新排队 ' + n + ' 个任务'); }); };
      bar.appendChild(br);
    }
    c.appendChild(bar);

    var list = dlTab === 'all' ? dlTasks : dlTasks.filter(function (t) { return t.status === dlTab; });
    if (!list.length) {
      c.appendChild(el('div', 'am-dlt-empty', dlTasks.length ? '此标签下没有任务' : '列表竟然是空的…'));
      return;
    }

    var tb = el('table', 'am-table am-dlt-table');
    tb.innerHTML = '<thead><tr><th style="width:44px;text-align:center">#</th><th>歌曲名</th>' +
      '<th style="width:150px">进度</th><th style="width:190px">状态</th>' +
      '<th style="width:76px">品质</th><th style="width:110px">操作</th></tr></thead>';
    var body = el('tbody');
    list.forEach(function (t, i) {
      var tr = el('tr', 'am-tr');
      var tdN = el('td', 'am-c-dim', String(i + 1)); tdN.style.textAlign = 'center';
      tr.appendChild(tdN);
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
      var pct = el('span', 'am-dlt-pct', t.status === 'done' ? '100%' : (t.total ? pctOf(t) + '%' : (t.received ? Math.floor(t.received / 1048576) + 'M' : '—')));
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
      var qb = el('span', 'am-qbadge' + ((t.quality === 'flac' || t.quality === 'flac24bit' || t.quality === 'master' || t.quality === 'hires') ? ' hq' : ''), qlab);
      tdQ.appendChild(qb);
      tr.appendChild(tdQ);
      // 操作
      var tdO = el('td');
      var ops = el('div', 'am-dlt-ops');
      if (t.status === 'downloading' || t.status === 'waiting') ops.appendChild(opBtn('⏸', '暂停', function () { window.mine.dlPause(t.id); }));
      if (t.status === 'paused') ops.appendChild(opBtn('▶', '继续', function () { window.mine.dlResume(t.id); }));
      if (t.status === 'error') ops.appendChild(opBtn('🔁', '重试', function () { window.mine.dlResume(t.id); }));
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

  window.annieAMDownload = { render: renderDlView };
})();
