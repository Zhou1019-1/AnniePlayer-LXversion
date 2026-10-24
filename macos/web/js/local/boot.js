'use strict';
/* 启动序列（V4.1 动效·仪式感版）：开屏 splash 的退场控制。
 * splash 本体是 index.html 的内联元素（首帧即显，不等 JS/CSS）；
 * 本模块负责：点火文案阶段切换、主界面首帧就绪检测、最短展示时间、淡出退场。
 * 兜底：8s 强制退场（防异常时白屏）；界面动效=关闭时跳过动画即时退场。 */
(function () {
  var splash = document.getElementById('boot-splash');
  if (!splash) return;
  // 遮罩通知已由 index.html 内联脚本更早完成（首帧前），这里不再重复调用
  var motion = 'full';
  try { motion = localStorage.getItem('annieplayer.ui.motion') || 'full'; } catch (e) { }
  var t0 = Date.now();
  var MIN_SHOW = motion === 'off' ? 300 : 1100; // 仪式感下限：logo 动画至少完整呈现一轮
  var statusEl = splash.querySelector('.bs-status');
  var stageT = setTimeout(function () {
    if (statusEl && statusEl.textContent === '引擎点火中…') statusEl.textContent = '曲库装载中…';
  }, 700);

  function isReady() {
    var theme = document.documentElement.dataset.theme || 'am';
    if (theme === 'am') return !!document.querySelector('#am-root .am-topbar'); // AM 首帧构建完成
    if (theme === 'fb2k') return !!document.querySelector('#fb2k-root > *');
    return true; // 粒子舞台为静态骨架，HTML 就绪即就绪
  }

  var out = false;
  function dismiss() {
    if (out) return;
    out = true;
    clearTimeout(stageT);
    // ⚠️ 2026-10-23 白屏修复 v3：splash 淡出前必须确保**主界面已经真正绘制**。
    //   之前 isReady() 只检查 DOM 节点存在（#am-root .am-topbar），
    //   但 DOM 就绪 ≠ 已 paint，splash 0.5s 淡出期间会露出白色画布。
    //   现在：双 requestAnimationFrame（第二帧时第一帧必然已绘制）+ 60ms 余量再开始淡出。
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        setTimeout(function () {
          if (motion === 'off') { splash.remove(); return; }
          splash.classList.add('bs-out');
          setTimeout(function () { splash.remove(); }, 520);
        }, 60);
      });
    });
  }

  var timer = setInterval(function () {
    var elapsed = Date.now() - t0;
    if (elapsed > 8000 || (elapsed >= MIN_SHOW && isReady())) {
      clearInterval(timer);
      dismiss();
    }
  }, 100);
})();
