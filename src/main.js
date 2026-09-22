'use strict';
// ============================================================================
// AnniePlayer SVLX —— 深度融合主进程
// 单窗口直接启动安妮播放器，流媒体源已集成 6 大平台：
//   netease / qq / kg(酷狗) / kw(酷我) / mg(咪咕) / lx(聚合)
// 借鉴 lx-music-desktop (Apache-2.0) 的桌面外壳：单例锁、便携模式、托盘
// ============================================================================
const { app, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const isDev = !app.isPackaged;
const ROOT = path.join(__dirname, '..');

// ----- 便携模式 (lx-music 风格) -----
if (process.platform === 'win32' && !isDev) {
  try {
    const portablePath = path.join(path.dirname(app.getPath('exe')), 'portable');
    if (fs.existsSync(portablePath)) {
      app.setPath('appData', portablePath);
      const userData = path.join(portablePath, 'userData');
      if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });
      app.setPath('userData', userData);
    }
  } catch { }
}

// ----- 单例锁 -----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

app.on('second-instance', () => {
  // Annie 主模块暴露的窗口恢复钩子
  if (typeof global.__svlxAnnieOpen === 'function') global.__svlxAnnieOpen();
});

// ----- 托盘 -----
let tray = null;
function createTray() {
  try {
    // 项目根 build/ 只有 icon.ico；托盘需要 png——用 annie/build/icon.png（真实存在的图标）
    const iconPath = path.join(ROOT, 'annie', 'build', 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('AnniePlayer SVLX');
    // 播控动作经 annie 主进程的 __svlxPlayerAction 转发给渲染层（与全局快捷键/任务栏按钮同通道）
    const act = (a) => () => { if (typeof global.__svlxPlayerAction === 'function') global.__svlxPlayerAction(a); };
    const ctx = [
      { label: '显示主窗口', click: () => { if (typeof global.__svlxAnnieOpen === 'function') global.__svlxAnnieOpen(); } },
      { type: 'separator' },
      { label: '播放 / 暂停', click: act('toggle') },
      { label: '上一首', click: act('prev') },
      { label: '下一首', click: act('next') },
      { type: 'separator' },
      { label: '迷你模式', click: act('mini') },
      { label: '桌面歌词', click: act('dlyrics') },
      { type: 'separator' },
      { label: '退出', click: () => { global.__svlxQuitting = true; app.quit(); } },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(ctx));
    tray.on('click', () => { if (typeof global.__svlxAnnieOpen === 'function') global.__svlxAnnieOpen(); });
    global.__svlxTray = tray; // V3.5.9：更新安装强退时供 main.js 销毁托盘
  } catch (e) { console.warn('[svlx] tray:', e.message); }
}

// ----- 启动 -----
app.whenReady().then(() => {
  createTray();
  // 设置标志：告诉 annie 不要自己搞 whenReady + 锁 + 托盘
  global.__svlxBoot = true;
  // 直接启动安妮播放器（流媒体源已集成 kg/kw/mg/netease/qq）
  require(path.join(ROOT, 'annie', 'main', 'main.js'));
});

// 安妮接管期间窗口全关不退出（回托盘）；用户点"退出"时设全局标记
app.on('window-all-closed', () => {
  if (global.__svlxQuitting) app.quit();
  // 否则保持后台，等待托盘操作
});
