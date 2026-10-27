import leaderboard from '/lx-gen/wy/leaderboard.js'
import { apis } from '/lx-gen/api-source.js'
import getLyric from '/lx-gen/wy/lyric.js'
import getMusicInfo from '/lx-gen/wy/musicInfo.js'
import musicSearch from '/lx-gen/wy/musicSearch.js'
import songList from '/lx-gen/wy/songList.js'
import hotSearch from '/lx-gen/wy/hotSearch.js'
import comment from '/lx-gen/wy/comment.js'
// import tipSearch from '/lx-gen/wy/tipSearch.js'

const wy = {
  // tipSearch,
  leaderboard,
  musicSearch,
  songList,
  hotSearch,
  comment,
  getMusicUrl(songInfo, type) {
    return apis('wy').getMusicUrl(songInfo, type)
  },
  getLyric(songInfo) {
    return getLyric(songInfo.songmid)
  },
  getPic(songInfo) {
    const requestObj = getMusicInfo(songInfo.songmid)
    return requestObj.promise.then(info => info.al.picUrl)
  },
  getMusicDetailPageUrl(songInfo) {
    return `https://music.163.com/#/song?id=${songInfo.songmid}`
  },
}

export default wy
