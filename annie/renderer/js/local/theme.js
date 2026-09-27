'use strict';
/* 界面主题管理器：粒子舞台(legacy) ↔ 仿 foobar2000(fb2k) ↔ Apple Music(am) 一键切换。
 * 主题存 localStorage（key: annieplayer.theme）；切换时 300ms 淡入淡出遮罩防布局闪烁；
 * 播放引擎与队列不受影响，状态天然连续。预留扩展：VALID 数组追加即可支持更多主题。 */
(function () {
  var KEY = 'annieplayer.theme';
  var VALID = ['legacy', 'fb2k', 'am'];
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { }
  // V3.5.2：首次安装默认 Apple Music 界面（老用户 localStorage 已有值，不受影响）
  var current = VALID.indexOf(stored) >= 0 ? stored : 'am';
  var switching = false;
  var swTimer1 = null, swTimer2 = null;

  function apply(theme) {
    current = theme;
    document.documentElement.dataset.theme = theme;
    // 通知粒子主循环跳过重负载渲染（11-main-loop.js 检查此标志）
    window.__legacyThemeHidden = theme !== 'legacy';
    var root = document.getElementById('fb2k-root');
    if (root) root.setAttribute('aria-hidden', theme === 'fb2k' ? 'false' : 'true');
    if (theme === 'fb2k' && window.annieFb2k) window.annieFb2k.mount();
    var amRoot = document.getElementById('am-root');
    if (amRoot) amRoot.setAttribute('aria-hidden', theme === 'am' ? 'false' : 'true');
    if (theme === 'am' && window.annieAM) window.annieAM.mount();
    document.dispatchEvent(new CustomEvent('annie-theme-changed', { detail: { theme: theme } }));
  }

  function doSwitch(theme) {
    if (switching) {
      // 上一次切换尚未完成：允许打断（定时器在窗口失焦时可能被节流到 1s，
      // 若静默丢弃会表现为"切换没反应"）
      clearTimeout(swTimer1); clearTimeout(swTimer2);
      var f0 = document.getElementById('theme-fade');
      if (f0) f0.classList.remove('on');
      switching = false;
    }
    switching = true;
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { }
    try { localStorage.setItem(KEY, theme); } catch (e) { }
    var fade = document.getElementById('theme-fade');
    if (fade) {
      fade.classList.add('on'); // 300ms 淡入（#000 10%）
      swTimer1 = setTimeout(function () {
        apply(theme);
        // 注意：不能用 requestAnimationFrame —— 窗口失焦/遮挡时 RAF 停摆，
        // 会导致 switching 永不复位、后续切换被永久阻塞
        swTimer2 = setTimeout(function () {
          fade.classList.remove('on'); // 淡出
          switching = false;
        }, 120);
      }, 300);
    } else {
      apply(theme);
      switching = false;
    }
  }

  /* AM 为主力开发界面；切往粒子舞台/FB2K 前弹确认（两个界面半停止开发） */
  var THEME_NAME = { legacy: '粒子舞台', fb2k: 'FB2K', am: 'AM' };
  function confirmLegacySwitch(theme) {
    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center';
    var box = document.createElement('div');
    box.style.cssText = 'background:#22252d;color:#e8ebf2;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:22px 26px;max-width:430px;box-shadow:0 16px 48px rgba(0,0,0,.55);font-size:14px;line-height:1.8';
    var msg = document.createElement('div');
    msg.textContent = '安妮播放器主力开发AM模拟界面，另外两个界面已经半停止开发，可能存在各类未知BUG，请问是否确认切换？';
    box.appendChild(msg);
    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:16px';
    var bCancel = document.createElement('button');
    bCancel.textContent = '取消';
    bCancel.style.cssText = 'padding:6px 20px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#cfd4de;cursor:pointer;font-size:13px';
    var bOk = document.createElement('button');
    bOk.textContent = '确认切换到 ' + (THEME_NAME[theme] || theme);
    bOk.style.cssText = 'padding:6px 20px;border-radius:8px;border:none;background:#e0485f;color:#fff;cursor:pointer;font-size:13px';
    bCancel.onclick = function () { mask.remove(); };
    bOk.onclick = function () { mask.remove(); doSwitch(theme); };
    mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
    btns.appendChild(bCancel); btns.appendChild(bOk);
    box.appendChild(btns); mask.appendChild(box);
    document.body.appendChild(mask);
  }

  function switchTheme(theme) {
    if (VALID.indexOf(theme) < 0) return;
    if (theme === current) return;
    if (theme !== 'am') { confirmLegacySwitch(theme); return; }
    doSwitch(theme);
  }

  window.annieTheme = {
    get current() { return current; },
    apply: apply,
    switch: switchTheme
  };

  // 启动时按存储主题应用（html dataset 已在 head 内联脚本中先行设置，避免闪屏）
  apply(current);
})();
