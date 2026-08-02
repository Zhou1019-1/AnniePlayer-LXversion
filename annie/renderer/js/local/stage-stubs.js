/* 安妮播放器 —— 视觉移植桩层（在模块之前加载）
 * 作用：
 *  1. 为被裁掉的功能组（歌单架/账户/桌面模式/播放网络层）补齐全局函数与变量，
 *     保证视觉模块在共享作用域里不因缺失符号崩溃；真实模块若自带同名实现会覆盖本文件。
 *  2. 为视觉模块引用的 DOM id 补隐藏桩元素（真实界面元素优先，已存在则跳过）。 */

// ---------- 缺失的全局变量（原属 05-playback 等被裁组） ----------
var trackSwitchToken = 0;
var currentIdx = -1;
var currentSong = null;
var playlist = [];
var playQueue = [];
var isPlaying = false;
var isSwitchingTrack = false;
var audioGraphReady = false;
var shelfManager = null; // 3D 歌单架已裁剪，视觉侧全部空值守卫
var shelfPinnedOpen = false;
var shelfVisibility = 0;
var shelfContentOpen = false;
var shelfPreviewVisible = false;
var gestureRotation = { x: 0, y: 0 };
var headParallax = { active: false, x: 0, y: 0 };
var sonicAudioFrame = null;

// ---------- 缺失的全局函数（被裁组的能力，视觉侧只是"调用一下"） ----------
function showToast(msg) { try { console.log('[toast]', msg); } catch (e) { } }
function notifyDesktopLyricsBeatMapReady() { }
function syncDesktopOverlayState() { }
function updateCustomLyricControls() { }
function applyPreferredLyricsForCurrent() { }
function setOriginalLyricsState() { }
function hasUsableLyricLines(lines) { return Array.isArray(lines) && lines.length > 0; }
function withLyricFallbackForSong(song, lines) { return Array.isArray(lines) ? lines : []; }
function currentLyricSong() { return currentSong; }
function apiJson() { return Promise.reject(new Error('网络层已裁剪')); }
function updatePlayButton() { }
function updateProgressBar() { }
function updateVolumeUI() { }
function refreshShelfVisibility() { }
function rebuildShelfIfNeeded() { }
function updateShelfDetailSync() { }
function markPlaybackUIReady() { }
function setupDesktopLyricsForTrack() { }
function updateDesktopLyricsWindow() { }
function requestDesktopOverlayRefresh() { }
function syncDesktopLyricsPlayback() { }
function startHomeWallpaperIdle() { }
function stopHomeWallpaperIdle() { }
function enterPlayVisualState() { }
function exitPlayVisualState() { }
function applyVisualPresetByIndex() { }
function scheduleQueueBeatPrefetch() { }
function writeBeatDiskCache() { }
function readBeatDiskCache() { return null; }
function showLocalBeatCacheModal() { }
function loginGateGuard(fn) { if (typeof fn === 'function') fn(); }
function getQishuiSession() { return null; }
function checkUpdateOnStartup() { }
function runStartupLoginGuide() { }
function initGestureControl() { }
function initPeekPanels() { }
function bindStartupShortcuts() { }
function updateShelfCameraFocus() { }
function getDesktopRenderPowerState() { return { active: false }; }
function updateHomeAudioVisual() { }
function tickGestureRotation() { }

// ---------- 空闲引导（idle guide，上游已裁剪）：视觉模块仅调用，补空实现 ----------
// 缺失会导致 window mousemove 每次抛出 ReferenceError，并中断后续舞台旋转/视差逻辑
function idleGuidePointerDown() { }
function idleGuidePointerMove() { }
function idleGuidePointerUp() { }
function idleGuidePointerLeave() { }
function idleGuideWheel() { }

// ---------- 粒子惯性旋转（spin，上游已裁剪）：拖拽旋转时被调用，补空实现 ----------
function applyParticleSpinDrag(dx, dy, dt) { }

// ---------- 封面代理（本地版无需代理，直接返回原 URL；Electron 主进程已注入 Referer） ----------
function coverProxySrc(url, cacheBust) {
  if (!url) return '';
  if (/^data:image\//i.test(url) || /^blob:/i.test(url)) return url;
  if (!/^https?:\/\//i.test(url)) return '';
  return url;
}

// ---------- 加载期读取的偏好（原属 05-playback，本地版给默认空值） ----------
var PLAYBACK_QUALITY_DEFAULTS = { netease: 'lossless', qq: 'lossless', kugou: 'lossless', qishui: 'lossless', spotify: 'lossless' };
function readCustomCoverMap() { try { return JSON.parse(localStorage.getItem('annie.customCovers') || '{}') || {}; } catch (e) { return {}; } }
function readCustomLyricMap() { try { return JSON.parse(localStorage.getItem('annie.customLyrics') || '{}') || {}; } catch (e) { return {}; } }
function readCustomLyricPrefs() { try { return JSON.parse(localStorage.getItem('annie.customLyricPrefs') || '{}') || {}; } catch (e) { return {}; } }
function readPlaybackQualityPreference() { return { netease: 'lossless', qq: 'lossless', kugou: 'lossless', qishui: 'lossless', spotify: 'lossless' }; }
function getProviderPlaybackQuality() { return 'lossless'; }
function readAudioOutputDevicePreference() { return ''; }
function saveAudioOutputDevicePreference() { }

function readAudioOutputMirrorPreference() { return ''; }
function readAudioInputBridgePreference() { return ''; }
function readHotkeySettings() { return {}; }
function loadListenStatsState() { return { totalSeconds: 0, totalPlays: 0, songs: {} }; }
function saveAudioOutputMirrorPreference() { }

// ---------- DOM 桩 ----------
(function installDomStubs() {
  // id → 标签类型（默认 div；仅少数对行为敏感的用 img/canvas/input）
  var IMG_IDS = {
    'thumb-cover': 1, 'control-cover': 1, 'cover-crop-img': 1
  };
  var CANVAS_IDS = {
    'sonic-audio-monitor-canvas': 1, 'cover-crop-preview': 1
  };
  var INPUT_IDS = {
    'user-archive-share-input': 1, 'color-lab-hex': 1, 'visual-tint-picker': 1
  };
  var ids = [
    'ai-depth-chip', 'ai-depth-text',
    'bottom-handle', 'close-behavior-seg', 'color-lab-cursor', 'color-lab-hue',
    'color-lab-pop', 'color-lab-presets', 'color-lab-preview', 'color-lab-sv',
    'color-lab-title', 'control-artist', 'control-title', 'control-title-badges',
    'control-title-text', 'controls-hide-btn', 'cover-color-pop', 'cover-crop-modal',
    'cover-crop-stage', 'cover-crop-zoom', 'free-camera-hint', 'fx-fab',
    'fx-fab-hide-btn', 'fx-panel', 'hotkey-modal', 'local-beat-cancel-btn',
    'local-beat-desc', 'local-beat-later-btn', 'local-beat-modal', 'local-beat-start-btn',
    'local-beat-status', 'local-beat-sub', 'local-beat-tab-dj', 'local-beat-tab-mr',
    'local-beat-title', 'memory-mask-seg', 'memory-status-chip', 'mini-queue-popover',
    'playlist-panel', 'preset-grid', 'quality-control', 'sonic-audio-meter-fill',
    'sonic-audio-monitor-label', 'sonic-audio-monitor-panel', 'sonic-audio-monitor-toggle',
    'startup-resume-mode-seg', 't-sonicAudioAutoTrack', 't-sonicAudioMonitorEnabled',
    't-startupAutoplay', 't-startupFastSkip', 'user-archive-grid', 'user-btn',
    'user-capsule-hide-btn', 'visual-tint-auto-btn', 'volume-control'
  ];
  var holder = document.createElement('div');
  holder.id = 'dom-stub-holder';
  holder.style.display = 'none';
  holder.setAttribute('aria-hidden', 'true');
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    if (document.getElementById(id)) continue; // 真实元素优先
    var tag = IMG_IDS[id] ? 'img' : (CANVAS_IDS[id] ? 'canvas' : (INPUT_IDS[id] ? 'input' : 'div'));
    var el = document.createElement(tag);
    el.id = id;
    holder.appendChild(el);
  }
  // 特殊：crop 预览画布给个尺寸，避免 getContext('2d') 拿到 0 尺寸报错
  var crop = holder.querySelector('#cover-crop-preview');
  if (crop) { crop.width = 160; crop.height = 160; }
  var sonic = holder.querySelector('#sonic-audio-monitor-canvas');
  if (sonic) { sonic.width = 320; sonic.height = 108; }
  document.body.appendChild(holder);
})();
