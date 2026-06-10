// ==UserScript==
// @name         Instatakker v1 BEAST
// @namespace    http://instatakker.io
// @version      1.0.0
// @description  Instagram automation — No-Limit Beast Mode with Fingerprint Spoofing
// @author       Instatakker
// @match        https://www.instagram.com/*
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  const VERSION = '1.0.0-BEAST';

  // ========================================================================
  //  BEAST CONFIG & FINGERPRINT GENERATOR
  // ========================================================================
  
  const genFingerprint = () => ({
    ua: navigator.userAgent,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency || 4,
    mem: navigator.deviceMemory || 8,
    lang: navigator.language,
    res: `${screen.width}x${screen.height}`,
    seed: Math.random().toString(36).substring(7)
  });

  const FP = genFingerprint();

  // Advanced Navigator Spoofing (Harder to detect automation)
  const applySpoof = () => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    log(`Fingerprint Applied: ${FP.seed} | Cores: ${FP.cores}`);
  };
  applySpoof();

  const cfg = {
    minDelay: 1500, // Aggressive but varied
    maxDelay: 5000,
    stealthBreakChance: 0.05,
    scrollDistance: 800
  };

  let running = false;
  let stopped = false;
  let mode = 'like'; // Default to Beast Like

  const st = {
    total: 0,
    posts: 0,
    comments: 0,
    unfollowed: 0,
    sessionStart: Date.now()
  };

  // ========================================================================
  //  HUMAN ENTROPY ENGINE
  // ========================================================================

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  
  // Gaussian jitter to avoid "Bot Rhythms"
  const jitter = (ms) => {
    const dev = ms * 0.3;
    return Math.floor(ms + (Math.random() * dev * 2 - dev));
  };

  const humanScroll = async () => {
    const dist = rand(300, 700);
    for(let i=0; i<5; i++) {
        window.scrollBy({ top: dist/5, behavior: 'smooth' });
        await sleep(rand(100, 300));
    }
  };

  const log = msg => console.log(`%c[BEAST] ${msg}`, "color: #00ffcc; font-weight: bold;");

  // ========================================================================
  //  DOM INTERACTION (ULTRA COMPATIBILITY)
  // ========================================================================

  const getLikeButton = (area = document) => {
    const svg = area.querySelector('svg[aria-label="Like"], svg[aria-label="Unlike"]');
    if (svg && svg.getAttribute('aria-label') === 'Like') {
      return svg.closest('button') || svg.closest('div[role="button"]');
    }
    return null;
  };

  const getCommentHearts = () => {
    return [...document.querySelectorAll('ul ul svg[aria-label="Like"]')];
  };

  const nextPost = () => {
    const nextArr = document.querySelector('svg[aria-label="Next"]');
    if (nextArr) {
      const btn = nextArr.closest('button');
      if (btn) btn.click();
      return true;
    }
    return false;
  };

  // ========================================================================
  //  BEAST MODE ENGINE
  // ========================================================================

  async function startBeast() {
    const logEl = document.getElementById('itk-log');
    const stEl = document.getElementById('itk-status');

    while (running && !stopped) {
      if (mode === 'like') {
        // Find post or open one
        if (!document.querySelector('div[role="dialog"]')) {
          logEl.textContent = "🔍 Hunting for posts...";
          const pool = [...document.querySelectorAll('article a[href*="/p/"]')];
          if (pool.length > 0) {
            pool[rand(0, Math.min(pool.length-1, 3))].click();
            await sleep(jitter(3000));
          } else {
            await humanScroll();
            await sleep(2000);
            continue;
          }
        }

        // Like the Post
        const pBtn = getLikeButton();
        if (pBtn) {
          logEl.textContent = "🔥 Crushing Post Like...";
          pBtn.click();
          st.total++; st.posts++;
          updateUI();
          await sleep(jitter(2000));
        }

        // Recursive Comment Nuking
        logEl.textContent = "🧨 Nuking comments...";
        let commentsInThisPost = 0;
        for (let i = 0; i < 5; i++) { // Max 5 batches of comments
            const hearts = getCommentHearts();
            if (hearts.length === 0) break;
            
            for (const h of hearts) {
                if (!running || stopped) break;
                const btn = h.closest('button') || h.parentElement;
                if (btn) {
                    btn.click();
                    st.total++; st.comments++;
                    commentsInThisPost++;
                    updateUI();
                    await sleep(jitter(1200));
                }
            }
            // Load more comments
            const more = document.querySelector('svg[aria-label="Load more comments"]');
            if (more) {
                more.closest('button').click();
                await sleep(jitter(2000));
            } else break;
        }

        logEl.textContent = `✅ Post Clean: +${commentsInThisPost} likes`;

        // Next Target
        if (running && !stopped) {
            if (!nextPost()) {
                document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
                await sleep(jitter(2000));
                await humanScroll();
            }
            await sleep(jitter(3000));
        }

      } else {
        // High Speed Unfollow (Preserved/Optimized)
        const btns = [...document.querySelectorAll('button')].filter(b => b.innerText === 'Following');
        if (btns.length > 0) {
            btns[0].click();
            await sleep(jitter(1000));
            const conf = [...document.querySelectorAll('button')].find(b => b.innerText === 'Unfollow');
            if (conf) {
                conf.click();
                st.unfollowed++; st.total++;
                updateUI();
                logEl.textContent = `🗑 Unfollowed: ${st.unfollowed}`;
            }
        } else {
            window.scrollBy(0, 500);
        }
        await sleep(jitter(5000));
      }

      // Random "Human Distraction" break (The 3-15 min wait)
      if (Math.random() < cfg.stealthBreakChance) {
          const wait = rand(180000, 600000);
          logEl.textContent = `🚬 Stealth Break: ${Math.round(wait/60000)}m`;
          await sleep(wait);
      }
    }
  }

  // ========================================================================
  //  CLEAN UI
  // ========================================================================

  function createPanel() {
    if (document.getElementById('itk-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'itk-panel';
    panel.style.cssText = `position:fixed;bottom:20px;left:20px;z-index:9999;width:320px;background:#050505;border:1px solid #00ffcc;border-radius:15px;padding:15px;color:white;box-shadow:0 0 20px #00ffcc55;font-family:monospace;`;
    
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;color:#00ffcc;border-bottom:1px solid #333;padding-bottom:10px;margin-bottom:10px;">
        <span style="font-weight:bold;">INSTATAKKER BEAST</span>
        <span style="font-size:10px;">${VERSION}</span>
      </div>
      <div id="itk-status" style="text-align:center;padding:10px;background:#111;margin-bottom:10px;border-radius:5px;border:1px solid #222;">SYSTEM IDLE</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <div style="background:#111;padding:10px;border-radius:5px;border:1px solid #222;">LIKES: <span id="itk-likes">0</span></div>
        <div style="background:#111;padding:10px;border-radius:5px;border:1px solid #222;">UNFOLL: <span id="itk-unf">0</span></div>
      </div>
      <div id="itk-log" style="font-size:11px;color:#00ffcc;height:30px;overflow:hidden;opacity:0.8;">[${FP.seed}] BEAST CORE INITIALIZED...</div>
      <div style="font-size:9px;color:#666;margin-top:10px;text-align:center;">ENTER: START/STOP | TAB: CHANGE MODE</div>
    `;
    document.body.appendChild(panel);
  }

  function updateUI() {
    document.getElementById('itk-likes').textContent = st.total;
    document.getElementById('itk-unf').textContent = st.unfollowed;
  }

  // ========================================================================
  //  CONTROLS
  // ========================================================================

  window.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        if (!running) {
            running = true; stopped = false;
            document.getElementById('itk-status').textContent = "BEAST RUNNING";
            document.getElementById('itk-status').style.color = "#00ffcc";
            startBeast();
        } else {
            running = false; stopped = true;
            document.getElementById('itk-status').textContent = "SYSTEM PAUSED";
            document.getElementById('itk-status').style.color = "orange";
        }
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        mode = mode === 'like' ? 'unfollow' : 'like';
        document.getElementById('itk-log').textContent = `MODE SWAP: -> ${mode.toUpperCase()}`;
    }
  });

  setTimeout(createPanel, 2000);
  log("Beast Mode Injected. [Enter] to unleash.");
})();
