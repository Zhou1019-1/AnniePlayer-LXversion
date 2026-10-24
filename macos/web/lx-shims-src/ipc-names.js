// IPC 名称常量
export const WIN_MAIN_RENDERER_EVENT_NAME = {
  request: 'request',
  response: 'response',
  download: 'download',
  hotKey: 'hotKey',
  clearLog: 'clearLog',
  log: 'log',
  inited: 'inited',
  update: 'update',
  updateProcess: 'updateProcess',
  updateError: 'updateError',
  showUpdateAvailable: 'showUpdateAvailable',
  handle_kw_decode_lyric: 'handle_kw_decode_lyric',
  handle_tx_decode_lyric: 'handle_tx_decode_lyric',
  handle_lyric_decode: 'handle_lyric_decode',
};
export const IPC_NAMES = { winMain: WIN_MAIN_RENDERER_EVENT_NAME };
export default IPC_NAMES;
