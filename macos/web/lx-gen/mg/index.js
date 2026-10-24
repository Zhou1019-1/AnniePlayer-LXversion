import { apis } from '/lx-gen/api-source.js'
import leaderboard from '/lx-gen/mg/leaderboard.js'
import songList from '/lx-gen/mg/songList.js'
import musicSearch from '/lx-gen/mg/musicSearch.js'
import pic from '/lx-gen/mg/pic.js'
import lyric from '/lx-gen/mg/lyric.js'
import hotSearch from '/lx-gen/mg/hotSearch.js'
import comment from '/lx-gen/mg/comment.js'
// import tipSearch from '/lx-gen/mg/tipSearch.js'

const mg = {
  // tipSearch,
  songList,
  musicSearch,
  leaderboard,
  hotSearch,
  comment,
  getMusicUrl(songInfo, type) {
    return apis('mg').getMusicUrl(songInfo, type)
  },
  getLyric(songInfo) {
    return lyric.getLyric(songInfo)
  },
  getPic(songInfo) {
    return pic.getPic(songInfo)
  },
  getMusicDetailPageUrl(songInfo) {
    return `http://music.migu.cn/v3/music/song/${songInfo.copyrightId}`
  },
}

export default mg
