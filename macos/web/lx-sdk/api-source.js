// 替换版 api-source.js —— 桥接到安妮主进程的自定义音源运行时 (sources.js)
// 原版 LX 通过 @renderer/store 的 userApi 走渲染层 IPC；
// 这里直接通过 globalThis.__svlxApis 调 CJS 侧 sources.handleRequest。
// 与洛雪 2.x 一致：播放 URL 完全由用户导入的音源脚本提供。

const callSource = (source, action, info) => {
  const bridge = globalThis.__svlxApis;
  if (!bridge) return Promise.reject(new Error('音源服务未就绪'));
  return bridge.call(source, action, info);
};

const apis = (source) => ({
  getMusicUrl(songInfo, type) {
    return callSource(source, 'musicUrl', { type, musicInfo: songInfo });
  },
  getLyric(songInfo) {
    return callSource(source, 'lyric', { musicInfo: songInfo });
  },
  getPic(songInfo) {
    return callSource(source, 'pic', { musicInfo: songInfo });
  },
});

const supportQuality = {};

export { apis, supportQuality };
