/* ============================================================
 * V4.3.16：平台分享链接反推（群友需求）。
 * 曲目/歌单 meta 里本就带平台原生 ID，按各平台官方详情页模板拼链接。
 * 模板与 lx-sdk 各平台 getMusicDetailPageUrl/getDetailPageUrl 保持一致。
 * ============================================================ */
(function () {
  'use strict';

  /** 曲目分享链接。song 为 normalize 产物（.meta 是洛雪原始 info）；拼不出返回 '' */
  function trackUrl(provider, song) {
    var m = (song && song.meta) || song || {};
    switch (provider) {
      case 'tx': return m.songmid ? 'https://y.qq.com/n/yqq/song/' + m.songmid + '.html' : '';
      case 'wy': return m.songmid ? 'https://music.163.com/song?id=' + m.songmid : '';
      case 'kg': return m.hash ? 'https://www.kugou.com/song/#hash=' + m.hash + (m.albumId ? '&album_id=' + m.albumId : '') : '';
      case 'kw': return m.songmid ? 'http://www.kuwo.cn/play_detail/' + m.songmid : '';
      case 'mg': return m.copyrightId ? 'https://music.migu.cn/v3/music/song/' + m.copyrightId : '';
      case 'qobuz': {
        var qid = (song && song.id) || m.id;
        return qid ? 'https://open.qobuz.com/track/' + qid : '';
      }
    }
    return '';
  }

  /** 歌单分享链接（平台 + 原生歌单 id）；拼不出返回 '' */
  function playlistUrl(provider, id) {
    id = String(id || '');
    if (!id) return '';
    switch (provider) {
      case 'tx': return 'https://y.qq.com/n/ryqq/playlist/' + id;
      case 'wy': return 'https://music.163.com/playlist?id=' + id;
      case 'kg': return 'https://www.kugou.com/yy/special/single/' + id + '.html';
      case 'kw': return 'http://www.kuwo.cn/playlist_detail/' + id;
      case 'mg': return 'https://music.migu.cn/v3/music/playlist/' + id;
    }
    return '';
  }

  /** 复制到剪贴板（走主进程 electron clipboard，file:// 域下最稳）。返回 Promise<bool> */
  function copy(text) {
    if (!text) return Promise.resolve(false);
    if (window.mine && window.mine.copyText) return window.mine.copyText(text).then(function () { return true; }, function () { return false; });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    return Promise.resolve(false);
  }

  window.annieShare = { trackUrl: trackUrl, playlistUrl: playlistUrl, copy: copy };
})();
