/*
 * Instatakker v1.0.1
 * Copyright © 2026 Instatakker. All rights reserved.
 */

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const APP_VERSION = "1.0.1";

const GITHUB_BASE =
  "https://raw.githubusercontent.com/issaghostlife/instatakker-app/main";

const CORE_URL = `${GITHUB_BASE}/instatakker-core.js`;
const NEWS_URL = `${GITHUB_BASE}/news.json`;

let mainWindow;

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function fetchTextWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${url}?t=${Date.now()}`, {
      signal: controller.signal,
      headers: {
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      }
    });

    if (!res.ok) {
      throw new Error(`Request failed with ${res.status}`);
    }

    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#0f0f1a",
    show: false,
    icon: path.join(__dirname, "build", "icon.ico"),
    title: `Instatakker v${APP_VERSION}`,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    console.log("[PAGE LOAD ERROR]", errorCode, errorDescription);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[APP] index.html loaded");
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("load-instagram", async () => {
  return "https://www.instagram.com";
});

ipcMain.handle("get-app-version", async () => {
  return APP_VERSION;
});

ipcMain.handle("get-script", async () => {
  const localPath = path.join(__dirname, "instatakker-core.js");
  const cachePath = path.join(app.getPath("userData"), "instatakker-core-cache.js");

  try {
    console.log("[APP] Checking latest Instatakker core from GitHub...");

    const script = await fetchTextWithTimeout(CORE_URL);

    if (!script || !script.includes("Instatakker")) {
      throw new Error("Downloaded script did not look valid");
    }

    fs.writeFileSync(cachePath, script, "utf8");
    console.log("[APP] Loaded latest core from GitHub");

    return script;
  } catch (err) {
    console.log("[APP] Could not load remote core. Using backup.", err.message);

    if (fs.existsSync(cachePath)) {
      console.log("[APP] Using cached core script");
      return fs.readFileSync(cachePath, "utf8");
    }

    if (fs.existsSync(localPath)) {
      console.log("[APP] Using bundled local core script");
      return fs.readFileSync(localPath, "utf8");
    }

    console.log("[ERROR] No core script available");
    return "";
  }
});

ipcMain.handle("get-news", async () => {
  const cachePath = path.join(app.getPath("userData"), "news-cache.json");

  try {
    console.log("[APP] Checking latest Instatakker news from GitHub...");

    const raw = await fetchTextWithTimeout(NEWS_URL);
    const news = JSON.parse(raw);

    if (!news || typeof news !== "object") {
      throw new Error("News JSON did not look valid");
    }

    safeWriteJson(cachePath, news);

    return {
      ok: true,
      source: "remote",
      data: news
    };
  } catch (err) {
    console.log("[APP] Could not load remote news. Using fallback.", err.message);

    const cached = safeReadJson(cachePath);

    if (cached) {
      return {
        ok: true,
        source: "cache",
        data: cached
      };
    }

    return {
      ok: false,
      source: "fallback",
      data: {
        version: APP_VERSION,
        title: "Instatakker News",
        items: [
          "Live news is not available right now.",
          "Once GitHub news.json is online, updates will appear here automatically."
        ],
        notice: "Copyright © 2026 Instatakker. All rights reserved."
      }
    };
  }
});

ipcMain.handle("save-limits", async (event, data) => {
  const limitsPath = path.join(app.getPath("userData"), "limits.json");

  try {
    safeWriteJson(limitsPath, data || {});
    return true;
  } catch (err) {
    console.log("[ERROR] Failed to save limits:", err.message);
    return false;
  }
});

ipcMain.handle("load-limits", async () => {
  const limitsPath = path.join(app.getPath("userData"), "limits.json");
  return safeReadJson(limitsPath, null);
});

ipcMain.handle("app-quit", () => {
  app.quit();
});

ipcMain.handle("app-minimize", () => {
  if (mainWindow) mainWindow.minimize();
});

app.whenReady().then(() => {
  createWindow();

  app.on("web-contents-created", (event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});