let currentMode = "unfollow";
let running = false;

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

function switchMode(mode) {
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
  const browserPanel = $("browser-panel");
  const browser = $("browser");
  const urlBar = $("url-bar");

  if (!browser) {
    log("Missing webview #browser");
    return;
  }

  const url = await window.instatakkerAPI.loadInstagram();

  if (browserPanel) browserPanel.style.display = "block";
  if (urlBar) urlBar.value = url;

  browser.src = url;

  log("Opening Instagram...");
  setStatus("Instagram loading...");
}

async function injectScript() {
  const browser = $("browser");

  if (!browser) {
    log("Missing browser webview.");
    return;
  }

  if (!browser.src || browser.src === "about:blank") {
    await openInstagram();
    log("Instagram opened. Login first, then click Start again.");
    return;
  }

  const script = await window.instatakkerAPI.getScript();

  if (!script || !script.trim()) {
    log("Missing instatakker-core.js. Copy your userscript into the app folder.");
    alert("Missing instatakker-core.js");
    return;
  }

  try {
    await browser.executeJavaScript(script);
    running = true;
    setStatus(`Running ${currentMode} mode`);
    log(`Injected InstaTakker script. Press Enter inside Instagram or use the floating panel.`);
  } catch (err) {
    console.error(err);
    log("Script injection failed. Check DevTools.");
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
    startBtn.addEventListener("click", injectScript);
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
      if (browser) browser.reload();
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

  document.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || e.repeat) return;
    if (e.target && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;

    e.preventDefault();
    await injectScript();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireButtons();
  switchMode("unfollow");
  log("Ready. Click Open Instagram to start.");
});