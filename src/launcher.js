'use strict';
// SVLX 启动器渲染逻辑
(async () => {
  try {
    document.getElementById('ver').textContent = 'SVLX ' + await window.svlx.version();
  } catch { }

  try {
    const st = await window.svlx.lxStatus();
    if (!st.available) {
      document.getElementById('lx-missing').textContent = '(组件构建中,暂不可启动)';
    }
  } catch { }

  document.getElementById('card-annie').addEventListener('click', () => window.svlx.launchAnnie());
  document.getElementById('card-lx').addEventListener('click', () => window.svlx.launchLX());
  document.getElementById('min').addEventListener('click', () => window.svlx.winMin());
  document.getElementById('close').addEventListener('click', () => window.svlx.winClose());
  document.getElementById('lnk').addEventListener('click', () => window.svlx.openThirdParty());
})();
