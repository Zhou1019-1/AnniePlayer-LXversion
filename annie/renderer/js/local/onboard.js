'use strict';
/* V3.5.15：首次启动引导（仅当 localStorage 未标记 且 曲库无任何文件夹时弹出）。
 * 三步：欢迎/选主题 → 添加音乐文件夹（可跳过） → 完成。
 * 三主题通用：覆盖层挂 document.body，样式自带（.ob-*），不依赖任何主题 CSS。 */
(function () {
  var LS_KEY = 'annieplayer.onboarded';
  function el(tag, cls, text) { var d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; }

  function done() {
    try { localStorage.setItem(LS_KEY, '1'); } catch (e) { }
    var ov = document.getElementById('ob-overlay');
    if (ov) ov.remove();
  }

  function show(lib) {
    if (document.getElementById('ob-overlay')) return;
    var ov = el('div'); ov.id = 'ob-overlay';
    var card = el('div', 'ob-card');
    ov.appendChild(card);
    document.body.appendChild(ov);

    var folders = (lib && lib.folders) || [];

    /* ---------- 第 1 步：欢迎 + 选主题 ---------- */
    function step1() {
      card.innerHTML = '';
      card.appendChild(el('div', 'ob-title', '欢迎使用 安妮播放器'));
      card.appendChild(el('div', 'ob-sub', 'HiFi 本地播放 · 独占输出 · 三界面主题。先挑一个喜欢的界面：'));
      var row = el('div', 'ob-themes');
      var cur = document.documentElement.dataset.theme || 'am';
      [['legacy', '粒子舞台', '3D 粒子可视化舞台'], ['fb2k', 'FB2K', '经典列表，信息密度高'], ['am', 'Apple Music', '现代流媒体风格']].forEach(function (t) {
        var c = el('button', 'ob-theme' + (cur === t[0] ? ' cur' : ''));
        c.appendChild(el('div', 'ob-theme-name', t[1]));
        c.appendChild(el('div', 'ob-theme-desc', t[2]));
        c.onclick = function () {
          cur = t[0];
          row.querySelectorAll('.ob-theme').forEach(function (x) { x.classList.remove('cur'); });
          c.classList.add('cur');
          if (window.annieTheme) window.annieTheme.switch(t[0]);
        };
        row.appendChild(c);
      });
      card.appendChild(row);
      var btns = el('div', 'ob-btns');
      var next = el('button', 'ob-btn pri', '下一步');
      next.onclick = step2;
      btns.appendChild(next);
      card.appendChild(btns);
    }

    /* ---------- 第 2 步：添加音乐文件夹 ---------- */
    function step2() {
      card.innerHTML = '';
      card.appendChild(el('div', 'ob-title', '添加音乐文件夹'));
      card.appendChild(el('div', 'ob-sub', '播放器会扫描文件夹内的音频文件建立曲库（稍后也可在 设置中心 → 媒体库 中添加）。'));
      var listBox = el('div', 'ob-folders');
      function renderFolders() {
        listBox.innerHTML = '';
        if (!folders.length) { listBox.appendChild(el('div', 'ob-hint', '（尚未添加）')); return; }
        folders.forEach(function (f) { listBox.appendChild(el('div', 'ob-folder', f)); });
      }
      renderFolders();
      card.appendChild(listBox);
      var addBtn = el('button', 'ob-btn', '＋ 选择文件夹');
      addBtn.onclick = function () {
        window.mine.pickFolder().then(function (st) {
          folders = (st && st.folders) || folders;
          renderFolders();
          if (folders.length) window.mine.rescan().catch(function () { });
        }).catch(function () { });
      };
      card.appendChild(addBtn);
      var btns = el('div', 'ob-btns');
      var skip = el('button', 'ob-btn', '跳过');
      skip.onclick = step3;
      var next = el('button', 'ob-btn pri', folders.length ? '下一步' : '跳过');
      next.onclick = step3;
      btns.appendChild(skip); btns.appendChild(next);
      card.appendChild(btns);
    }

    /* ---------- 第 3 步：完成 ---------- */
    function step3() {
      card.innerHTML = '';
      card.appendChild(el('div', 'ob-title', '一切就绪'));
      card.appendChild(el('div', 'ob-sub',
        '双击歌曲开始播放。几个常用入口：\n' +
        '· 右上角 ⚙ 打开设置中心（输出设备 / 主题 / 歌词）\n' +
        '· 空格 播放暂停，Ctrl+K 命令面板\n' +
        '· 遇到问题：设置中心 → 曲库工具 → 导出诊断信息'));
      card.querySelector('.ob-sub').style.whiteSpace = 'pre-line';
      var btns = el('div', 'ob-btns');
      var go = el('button', 'ob-btn pri', '开始使用');
      go.onclick = done;
      btns.appendChild(go);
      card.appendChild(btns);
    }

    step1();
  }

  /* 启动后延迟检查：等主题/库初始化完再决定弹不弹 */
  setTimeout(function () {
    try { if (localStorage.getItem(LS_KEY) === '1') return; } catch (e) { return; }
    window.mine.getLibrary().then(function (lib) {
      var folders = (lib && lib.folders) || [];
      if (folders.length) { try { localStorage.setItem(LS_KEY, '1'); } catch (e) { } return; } // 老用户静默标记
      show(lib);
    }).catch(function () { });
  }, 1500);

  /* ================= V3.5.17：更新播报（版本变化后首次启动弹"本次更新内容"） =================
   * 数据源：GitHub raw 更新日志.md（提取当前版本段落）；离线/拉取失败静默跳过。
   * 与首次引导互斥：新用户先看引导，不弹播报。 */
  setTimeout(function () {
    if (!window.mine.appVersion) return;
    window.mine.appVersion().then(function (ver) {
      var SEEN_KEY = 'annieplayer.seenVersion';
      var seen = '';
      try { seen = localStorage.getItem(SEEN_KEY) || ''; } catch (e) { }
      if (seen === ver) return;
      try { localStorage.setItem(SEEN_KEY, ver); } catch (e) { }
      // 首次使用（引导未标记）不弹播报，避免与引导页叠加
      try { if (localStorage.getItem(LS_KEY) !== '1') return; } catch (e) { return; }
      fetch('https://raw.githubusercontent.com/Zhou1019-1/AnniePlayer-LXversion/main/%E6%9B%B4%E6%96%B0%E6%97%A5%E5%BF%97.md', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (md) {
          if (!md) return; // 离线静默
          var m = md.match(new RegExp('## V' + ver.replace(/\./g, '\\.') + '[（(][^）)]*[）)]\\s*([\\s\\S]+?)(?=\\r?\\n## V|$)'));
          var body = m ? m[1].trim() : '';
          if (!body) return;
          showWhatsNew(ver, body);
        })
        .catch(function () { });
    }).catch(function () { });
  }, 2600);

  function showWhatsNew(ver, bodyMd) {
    if (document.getElementById('ob-overlay')) return; // 引导页在就不打扰
    var ov = el('div'); ov.id = 'ob-overlay';
    var card = el('div', 'ob-card');
    card.appendChild(el('div', 'ob-title', '已更新到 V' + ver));
    var body = el('div', 'ob-sub');
    body.style.whiteSpace = 'pre-line';
    body.style.maxHeight = '46vh';
    body.style.overflowY = 'auto';
    // 轻量 markdown：去粗体标记，**xx** → xx（保持纯文本可读即可）
    body.textContent = bodyMd.replace(/\*\*/g, '').replace(/^#+\s*/gm, '');
    card.appendChild(body);
    var btns = el('div', 'ob-btns');
    var go = el('button', 'ob-btn pri', '知道了');
    go.onclick = function () { ov.remove(); };
    btns.appendChild(go);
    card.appendChild(btns);
    ov.appendChild(card);
    document.body.appendChild(ov);
  }
})();
