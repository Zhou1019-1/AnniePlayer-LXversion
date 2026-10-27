import leaderboard from '/lx-gen/bd/leaderboard.js'
import { apis } from '/lx-gen/api-source.js'
import musicInfo from '/lx-gen/bd/musicInfo.js'
import songList from '/lx-gen/bd/songList.js'
import { httpFetch } from '/lx-gen/shims/request.js'
import musicSearch from '/lx-gen/bd/musicSearch.js'
import hotSearch from '/lx-gen/bd/hotSearch.js'

const bd = {
  leaderboard,
  songList,
  musicSearch,
  hotSearch,
  getMusicUrl(songInfo, type) {
    return apis('bd').getMusicUrl(songInfo, type)
  },
  getPic(songInfo) {
    const requestObj = this.getMusicInfo(songInfo)
    return requestObj.promise.then(info => info.pic_premium)
  },
  getLyric(songInfo) {
    const requestObj = this.getMusicInfo(songInfo)
    requestObj.promise = requestObj.promise.then(info => httpFetch(info.lrclink).promise.then(resp => ({ lyric: resp.body, tlyric: '' })))
    return requestObj
  },
  // getLyric(songInfo) {
  //   return apis('bd').getLyric(songInfo)
  // },
  // getPic(songInfo) {
  //   return apis('bd').getPic(songInfo)
  // },
  getMusicInfo(songInfo) {
    return musicInfo.getMusicInfo(songInfo.songmid)
  },
  getMusicDetailPageUrl(songInfo) {
    return `http://music.taihe.com/song/${songInfo.songmid}`
  },
}

export default bd
