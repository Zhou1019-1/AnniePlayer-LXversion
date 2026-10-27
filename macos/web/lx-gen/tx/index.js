import leaderboard from '/lx-gen/tx/leaderboard.js'
import lyric from '/lx-gen/tx/lyric.js'
import songList from '/lx-gen/tx/songList.js'
import musicSearch from '/lx-gen/tx/musicSearch.js'
import { apis } from '/lx-gen/api-source.js'
import hotSearch from '/lx-gen/tx/hotSearch.js'
import comment from '/lx-gen/tx/comment.js'
// import tipSearch from '/lx-gen/tx/tipSearch.js'

const tx = {
  // tipSearch,
  leaderboard,
  songList,
  musicSearch,
  hotSearch,
  comment,

  getMusicUrl(songInfo, type) {
    return apis('tx').getMusicUrl(songInfo, type)
  },
  getLyric(songInfo) {
    // let singer = songInfo.singer.indexOf('、') > -1 ? songInfo.singer.split('、')[0] : songInfo.singer
    return lyric.getLyric(songInfo)
  },
  async getPic(songInfo) {
    return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${songInfo.albumId}.jpg`
  },
  getMusicDetailPageUrl(songInfo) {
    return `https://y.qq.com/n/yqq/song/${songInfo.songmid}.html`
  },
}

export default tx
