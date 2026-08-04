'use strict';
/* ============================================================================
 * V1.1.9：WASAPI 独占/共享输出开关
 *   - 底栏音频工具组（EQ 按钮右侧）图标开关：🔒 点亮 = 独占（默认）｜ 🔓 熄灭 = 共享
 *   - 独占：bit-perfect 直通，跨格式切歌需重建设备（发烧友模式）
 *   - 共享：系统混音器统一格式，永不切设备、不与其它程序冲突（兼容模式）
 *   - 持久化到 localStorage（ui.exclusive），启动时应用；切换需断流重建
 * ========================================================================== */
(function () {
  const LS_KEY = 'annieplayer.exclusive';
  let exclusive = true; // 默认独占

  /* ---------------- 持久化 ---------------- */
  function load() {
    try {
      const v = localStorage.getItem(LS_KEY);
      if (v !== null) exclusive = v === '1';
    } catch { }
  }
  function save() {
    try { localStorage.setItem(LS_KEY, exclusive ? '1' : '0'); } catch { }
  }

  /* ---------------- 引擎应用 ---------------- */
  // 重新选择当前设备（应用独占/共享设置）；切换会断流重建
  async function applyToEngine() {
    const kind = state && state.backendKind ? state.backendKind : 'wasapi';
    let id = null;
    if (state && state.library && state.library.backend) {
      const parts = state.library.backend.split('|');
      if (parts[0] === 'wasapi' && parts[1]) id = parts[1];
    }
    try {
      const r = await window.mine.engine('devices.select', { kind, id, exclusive });
      if (r && r.exclusive !== undefined) exclusive = r.exclusive;
    } catch { /* 引擎未就绪等场景静默，下次播放时 EnsureBackend 会用当前值 */ }
  }

  /* ---------------- 按钮 UI ---------------- */
  // V1.1.9：左上角徽章联动——独占点亮（金黄 live）、共享熄灭（灰色）
  function syncBadge() {
    const b = document.getElementById('tb-backend');
    if (!b) return;
    const isAsio = state && state.backendKind === 'asio';
    if (isAsio) return; // ASIO 不涉及独占/共享
    // 保留设备名（从当前文本提取 "· 设备名" 部分，无则不动）
    const m = b.textContent.match(/·\s*(.+)$/);
    const dev = m ? m[1] : '';
    b.textContent = `${exclusive ? 'WASAPI 独占' : 'WASAPI 共享'}${dev ? ' · ' + dev : ''}`;
    b.classList.toggle('live', exclusive);
  }
  // V1.1.9：bp-chip（bit-perfect 状态）联动——共享熄灭灰点、独占恢复绿/黄点
  function syncBpChip() {
    const chip = document.getElementById('bp-chip');
    if (!chip || chip.classList.contains('hidden')) return;
    if (typeof updateBpChip !== 'function' || !window.__lastFormat) return;
    updateBpChip(window.__lastFormat); // 用最后一次 format 数据按新独占状态重绘
  }

  // 锁图标（SVG，currentColor 跟随 .on 点亮为金黄色）——与 EQ 按钮同款 .ctl 动画：
  // .ctl 基础圆形 + .on 点亮（--accent 金黄），打开亮、关闭灭。
  // 锁体 + 锁梁：点亮=独占（上锁），熄灭=共享（开锁）
  const LOCK_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">' +
    '<path d="M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<rect x="3.6" y="7" width="8.8" height="6.4" rx="1.6" fill="currentColor"/>' +
    '<circle cx="8" cy="10.2" r="1" fill="#111"/>' +
    '</svg>';
  const UNLOCK_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">' +
    '<path d="M5.5 7V4.8a2.5 2.5 0 0 1 4.9-.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<rect x="3.6" y="7" width="8.8" height="6.4" rx="1.6" fill="currentColor"/>' +
    '<circle cx="8" cy="10.2" r="1" fill="#111"/>' +
    '</svg>';

  function syncBtn() {
    const b = document.getElementById('btn-excl');
    if (!b) return;
    b.classList.toggle('on', exclusive);
    b.innerHTML = exclusive ? LOCK_SVG : UNLOCK_SVG; // 上锁=独占点亮，开锁=共享熄灭
    b.title = exclusive
      ? 'WASAPI 独占输出（点亮）：bit-perfect 直通，跨格式切歌会重建设备'
      : 'WASAPI 共享输出（熄灭）：系统混音器统一格式，不切设备不冲突（兼容模式）';
  }

  function mount(group) {
    if (document.getElementById('btn-excl')) return;
    const btn = document.createElement('button');
    btn.id = 'btn-excl';
    btn.className = 'ctl';
    btn.innerHTML = exclusive ? LOCK_SVG : UNLOCK_SVG;
    btn.onclick = async () => {
      exclusive = !exclusive;
      save();
      syncBtn();
      syncBadge(); // V1.1.9：左上角徽章联动点亮/熄灭
      syncBpChip(); // V1.1.9：bit-perfect 状态联动（共享熄灭/独占恢复）
      // 提示：切换后当前播放会中断重建（断流）
      try { if (typeof proToast === 'function') proToast(exclusive ? '已切换独占输出（bit-perfect）' : '已切换共享输出（兼容模式）'); } catch { }
      await applyToEngine();
      // 若正在播放，重新起播当前曲目
      try {
        if (state && state.playing && state.currentPath) {
          await window.mine.engine('stop').catch(() => { });
          const t = state.queue[state.index];
          const path = t && t.cue ? t.cue.src : state.currentPath;
          const off = t && t.cue ? (t.cue.start || 0) : 0;
          const gain = typeof loudGainFor === 'function' ? loudGainFor(state.currentPath) : 1;
          await window.mine.engine('play', { path, offsetSec: off, loudGain: gain }, 30000).catch(() => { });
        }
      } catch { }
    };
    // EQ 按钮右侧插入
    const eqBtn = document.getElementById('btn-eq');
    if (eqBtn && eqBtn.nextSibling) group.insertBefore(btn, eqBtn.nextSibling);
    else group.appendChild(btn);
    syncBtn();
  }

  /* ---------------- 挂载 ---------------- */
  // V1.1.9：全局查询接口（player.js 徽章/format 事件读取）
  window.annieIsExclusive = () => exclusive;
  // EQ 注入完成后调用（eq.js 在 exclusive.js 之前加载，DOM ready 后 EQ 按钮已存在）
  window.annieMountExclusiveBtn = mount;

  // 启动：加载持久化设置 → 等引擎就绪后应用（带重试，引擎可能晚于渲染层拉起）
  load();
  document.addEventListener('DOMContentLoaded', () => {
    // 优先注入到 EQ 按钮所在组；EQ 尚未注入时等待
    const tryMount = () => {
      const group = document.querySelector('#controls .ctl-group.tools') || document.getElementById('controls');
      const eqBtn = document.getElementById('btn-eq');
      if (group && eqBtn) { mount(group); return true; }
      return false;
    };
    if (!tryMount()) {
      let tries = 0;
      const t = setInterval(() => {
        tries++;
        if (tryMount() || tries >= 20) clearInterval(t);
      }, 250);
    }
    // 引擎就绪后应用设置（boot 的 devices.select 之后执行）
    let appTries = 0;
    const t2 = setInterval(() => {
      appTries++;
      if (!exclusive) { // 仅非默认值需要主动应用（默认独占引擎天然如此）
        applyToEngine().then(() => clearInterval(t2)).catch(() => { });
      } else clearInterval(t2);
      if (appTries >= 15) clearInterval(t2);
    }, 400);
  });
})();
