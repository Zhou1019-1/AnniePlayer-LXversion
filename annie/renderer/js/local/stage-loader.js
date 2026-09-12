/* 安妮播放器 —— 视觉模块装配器
 * 与 Mineradio 同款思路：按序同步读取模块文本，拼接为一个脚本注入，
 * 使全部模块共享同一全局作用域（模块间以顶层 var/function 互相引用）。
 * 顺序：桩层 → 状态 → 场景 → 视觉 → 声波地形 → 节拍 → 歌词解析 → 预设 → 主循环。 */

(function loadAnnieStageModules() {
  var moduleCacheBust = String(Date.now());
  var modulePaths = [
    'js/local/stage-stubs.js',

    'js/modules/00-state/00-core-stores.js',
    'js/modules/00-state/01-perf-render-state.js',
    'js/modules/00-state/02-preferences-ui-modes.js',
    'js/modules/00-state/03-beat-dj-state.js',
    'js/modules/00-state/04-fx-defaults.js',
    'js/modules/00-state/05-packaged-fx-archive.js',
    'js/modules/00-state/06-fx-runtime-layout.js',
    'js/modules/00-state/07-ui-playback-runtime.js',
    'js/modules/00-state/08-desktop-render-power.js',
    'js/modules/00-state/09-performance-probe.js',
    'js/modules/00-state/10-frame-scheduler.js',
    'js/modules/00-state/11-system-memory-controls.js',

    'js/modules/01-scene/00-renderer-quality.js',
    'js/modules/01-scene/01-orbit-free-camera.js',
    'js/modules/01-scene/02-beat-camera-runtime.js',
    'js/modules/01-scene/03-focus-cinema-camera.js',
    'js/modules/01-scene/04-bottom-controls-cursor.js',

    'js/modules/02-visual/00-pointer-cover-particles.js',
    'js/modules/02-visual/01-float-skull-backcover.js',
    'js/modules/02-visual/02-lyrics-state-layout.js',
    'js/modules/02-visual/03-lyrics-star-river.js',
    'js/modules/02-visual/04-visual-settings-persistence.js',
    'js/modules/02-visual/05-lyrics-fonts-texture.js',
    'js/modules/02-visual/06-custom-background-colorlab.js',
    'js/modules/02-visual/07-lyrics-palette-text-utils.js',
    'js/modules/02-visual/08-lyrics-display-modes.js',
    'js/modules/02-visual/09-lyrics-payloads.js',
    'js/modules/02-visual/10-lyrics-mask-textures.js',
    'js/modules/02-visual/11-lyrics-shaders.js',
    'js/modules/02-visual/12-lyrics-row-layers.js',
    'js/modules/02-visual/13-lyrics-mesh-build.js',
    'js/modules/02-visual/14-stage-lyrics-rendering.js',
    'js/modules/02-visual/15-ripples-cover-depth.js',

    'js/sonic-topography-preset.js',
    'js/sonic-workshop-preset.js',

    'js/modules/03-beat/00-tempo-worker-cache-prefetch.js',
    'js/modules/03-beat/01-audio-beat-analysis.js',
    'js/modules/03-beat/02-podcast-dj-analysis.js',
    'js/modules/03-beat/03-local-beat-cache-modal.js',
    'js/modules/03-beat/04-beat-map-runtime.js',
    'js/modules/03-beat/05-cover-loading-crop.js',
    'js/modules/03-beat/06-sonic-audio-monitor.js',

    'js/modules/06-lyrics/00-lyrics-fetch-parse.js',

    'js/modules/07-fx/00-preset-archive-data.js',
    'js/modules/07-fx/04-preset-grid-uniforms.js',

    'js/modules/11-main-loop.js',
  ];

  function readModule(path) {
    var request = new XMLHttpRequest();
    request.open('GET', path + '?v=' + moduleCacheBust, false);
    request.send(null);
    if ((request.status < 200 || request.status >= 300) && request.status !== 0) {
      throw new Error('装配视觉模块失败: ' + path + ' (' + request.status + ')');
    }
    return request.responseText;
  }

  var script = document.createElement('script');
  script.text = modulePaths.map(readModule).join('\n;\n') + '\n//# sourceURL=annie-stage-modules.js\n';
  document.currentScript.parentNode.insertBefore(script, document.currentScript.nextSibling);
})();
