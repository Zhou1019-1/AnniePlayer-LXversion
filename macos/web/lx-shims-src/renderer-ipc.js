// renderer IPC shim —— 浏览器里没有 IPC，提供空实现
export const ipcRenderer = {
  invoke: async () => null,
  send: () => {},
  on: () => {},
  off: () => {},
  once: () => {},
};

/** 调用主进程处理（浏览器里直接返回 null） */
export async function rendererInvoke(...args) {
  return null;
}

export default { ipcRenderer, rendererInvoke };
