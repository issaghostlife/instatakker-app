/*
 * Instatakker v1.0.1
 * Copyright © 2026 Instatakker. All rights reserved.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("instatakkerAPI", {
  loadInstagram: () => ipcRenderer.invoke("load-instagram"),
  getScript: () => ipcRenderer.invoke("get-script"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getNews: () => ipcRenderer.invoke("get-news"),

  saveLimits: (data) => ipcRenderer.invoke("save-limits", data),
  loadLimits: () => ipcRenderer.invoke("load-limits"),

  quit: () => ipcRenderer.invoke("app-quit"),
  minimize: () => ipcRenderer.invoke("app-minimize")
});