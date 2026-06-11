/*
 * Instatakker v1.0.1
 * Copyright © 2026 Instatakker. All rights reserved.
 */

let currentMode = "unfollow";
let running = false;
let scriptInjected = false;

const APP_VERSION = "1.0.1";


const $ = (id) => document.getElementById(id);

function log(msg) {
  const el = $("log-content");
  if (el) el.textContent = msg;
  console.log("[Instatakker]", msg);
}

function setStatus(msg) {
  const el = $("status");
  if (el) el.textContent = msg;
}

function setRunningUI(isRunning) {
  running = isRunning;

  const startBtn = $("btn-start");

  if (startBtn) {
    startBtn.textContent = isRunning ? "Stop" : "Start";
    startBtn.classList.toggle("btn-secondary", isRunning);
    startBtn.classList.toggle("btn-primary", !isRunning);
  }
}

function switchMode(mode) {
  if (running) {
    log("Stop first before switching mode.");
    return;
  }

  currentMode = mode;

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  const unfollowSettings = $("settings-unfollow");
  const likeSettings = $("settings-like");
  const commentsBox = $("stat-comments-box");
  const engagedRow = $("engaged-row");

  if (unfollowSettings) unfollowSettings.style.display = mode === "unfollow" ? "block" : "none";
  if (likeSettings) likeSettings.style.display = mode === "like" ? "block" : "none";
  if (commentsBox) commentsBox.style.display = mode === "like" ? "block" : "none";
  if (engagedRow) engagedRow.style.display = mode === "like" ? "flex" : "none";

  log(`Mode selected: ${mode}`);
}

async function openInstagram() {
  const app = $("app");
  const browserPanel = $("browser-panel");
  const browser = $("browser");
  const urlBar = $("url-bar");

  if (!browser) {
    log("Missing webview #browser");
    return;
  }

  const url = await window.instatakkerAPI.loadInstagram();

  if (app) app.classList.add("browser-open");
  if (browserPanel) browserPanel.style.display = "block";
  if (urlBar) urlBar.value = url;

  browser.src = url;

  log("Opening Instagram...");
  setStatus("Instagram loading...");
}

async function ensureInstagramOpen() {
  const browser = $("browser");

  if (!browser) {
    log("Missing browser webview.");
    return false;
  }

  if (!browser.src || browser.src === "about:blank") {
    await openInstagram();
    log("Instagram opened. Login first, then click Start.");
    return false;
  }

  return true;
}

async function injectCoreIfNeeded() {
  const browser = $("browser");

  if (!browser) return false;

  if (scriptInjected) {
    return true;
  }

  const script = await window.instatakkerAPI.getScript();

  if (!script || !script.trim()) {
    log("Missing instatakker-core.js. Copy your userscript into the app folder.");
    alert("Missing instatakker-core.js");
    return false;
  }

  try {
    await browser.executeJavaScript(script);
    scriptInjected = true;
    log("Instatakker core loaded.");
    return true;
  } catch (err) {
    console.error(err);
    log("Script injection failed. Check DevTools.");
    return false;
  }
}

async function startAutomation() {
  const browser = $("browser");

  const instagramReady = await ensureInstagramOpen();
  if (!instagramReady) return;

  const injected = await injectCoreIfNeeded();
  if (!injected) return;

  try {
    const result = await browser.executeJavaScript(`
      (async () => {
        if (!window.Instatakker || typeof window.Instatakker.start !== "function") {
          return "MISSING_START_API";
        }

        window.Instatakker.start("${currentMode}");
        return "STARTED";
      })();
    `);

    if (result === "MISSING_START_API") {
      log("Core needs update: window.Instatakker.start() is missing.");
      alert("Your instatakker-core.js needs the new Start API.");
      return;
    }

    setRunningUI(true);
    setStatus(`Running ${currentMode} mode`);
    log(`Started ${currentMode} mode from main app.`);
  } catch (err) {
    console.error(err);
    log("Failed to start automation.");
  }
}

async function stopAutomation() {
  const browser = $("browser");

  if (!browser) return;

  try {
    await browser.executeJavaScript(`
      if (window.Instatakker && typeof window.Instatakker.stop === "function") {
        window.Instatakker.stop();
      }
    `);
  } catch (err) {
    console.error(err);
  }

  setRunningUI(false);
  setStatus("Stopped");
  log("Stopped by main app.");
}

async function toggleAutomation() {
  if (running) {
    await stopAutomation();
  } else {
    await startAutomation();
  }
}

async function loadNews() {
  const versionEl = $("news-version");
  const titleEl = $("news-title");
  const listEl = $("news-list");
  const noticeEl = $("news-notice");

  if (!versionEl || !titleEl || !listEl) return;

  try {
    const result = await window.instatakkerAPI.getNews();
    const news = result.data;

    versionEl.textContent = news.version ? `v${news.version}` : "v1.0.1";
    titleEl.textContent = news.title || "Latest Instatakker Updates";

    listEl.innerHTML = "";

    const items = Array.isArray(news.items) ? news.items : [];

    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      listEl.appendChild(li);
    });

    if (noticeEl) {
      noticeEl.textContent =
        news.notice || "Copyright © 2026 Instatakker. All rights reserved.";
    }
  } catch (err) {
    versionEl.textContent = "v1.0.1";
    titleEl.textContent = "News unavailable";
    listEl.innerHTML = "<li>Could not load live news.</li>";
  }
}

function wireButtons() {
  const minimizeBtn = $("btn-minimize");
  const closeBtn = $("btn-close");
  const openBtn = $("btn-open");
  const startBtn = $("btn-start");

  if (minimizeBtn) {
    minimizeBtn.addEventListener("click", () => {
      window.instatakkerAPI.minimize();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      window.instatakkerAPI.quit();
    });
  }

  if (openBtn) {
    openBtn.addEventListener("click", openInstagram);
  }

  if (startBtn) {
    startBtn.addEventListener("click", toggleAutomation);
  }

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchMode(btn.dataset.mode);
    });
  });

  const backBtn = $("btn-back");
  const forwardBtn = $("btn-forward");
  const refreshBtn = $("btn-refresh");
  const toggleBtn = $("btn-toggle-panel");
  const browser = $("browser");
  const panel = $("panel");

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      if (browser && browser.canGoBack()) browser.goBack();
    });
  }

  if (forwardBtn) {
    forwardBtn.addEventListener("click", () => {
      if (browser && browser.canGoForward()) browser.goForward();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      if (browser) {
        scriptInjected = false;
        setRunningUI(false);
        browser.reload();
      }
    });
  }

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      if (!panel) return;
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    });
  }

  if (browser) {
    browser.addEventListener("did-navigate", (e) => {
      scriptInjected = false;
      setRunningUI(false);

      const urlBar = $("url-bar");
      if (urlBar) urlBar.value = e.url;
    });

    browser.addEventListener("did-navigate-in-page", (e) => {
      const urlBar = $("url-bar");
      if (urlBar) urlBar.value = e.url;
    });

    browser.addEventListener("did-finish-load", () => {
      setStatus("Instagram loaded");
      log("Instagram loaded. Login if needed, then click Start.");
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  wireButtons();
  switchMode("unfollow");
  loadNews();
  log("Ready. Click Open Instagram, then Start.");
});