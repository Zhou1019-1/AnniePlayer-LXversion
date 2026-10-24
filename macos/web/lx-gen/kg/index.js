import leaderboard from '/lx-gen/kg/leaderboard.js'
import { apis } from '/lx-gen/api-source.js'
import songList from '/lx-gen/kg/songList.js'
import musicSearch from '/lx-gen/kg/musicSearch.js'
import pic from '/lx-gen/kg/pic.js'
import lyric from '/lx-gen/kg/lyric.js'
import hotSearch from '/lx-gen/kg/hotSearch.js'
import comment from '/lx-gen/kg/comment.js'
// import tipSearch from '/lx-gen/kg/tipSearch.js'

const kg = {
  // tipSearch,
  leaderboard,
  songList,
  musicSearch,
  hotSearch,
  comment,
  getMusicUrl(songInfo, type) {
    return apis('kg').getMusicUrl(songInfo, type)
  },
  getLyric(songInfo) {
    return lyric.getLyric(songInfo)
  },
  // getLyric(songInfo) {
  //   return apis('kg').getLyric(songInfo)
  // },
  getPic(songInfo) {
    return pic.getPic(songInfo)
  },
  getMusicDetailPageUrl(songInfo) {
    return `https://www.kugou.com/song/#hash=${songInfo.hash}&album_id=${songInfo.albumId}`
  },
  // getPic(songInfo) {
  //   return apis('kg').getPic(songInfo)
  // },
}

export default kg
