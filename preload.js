const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("instatakkerAPI", {
  loadInstagram: () => ipcRenderer.invoke("load-instagram"),
  getScript: () => ipcRenderer.invoke("get-script"),
  saveLimits: (data) => ipcRenderer.invoke("save-limits", data),
  loadLimits: () => ipcRenderer.invoke("load-limits"),
  quit: () => ipcRenderer.invoke("app-quit"),
  minimize: () => ipcRenderer.invoke("app-minimize"),
});