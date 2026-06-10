// ==UserScript==
// @name         Instatakker v1.0.0 BEAST (Auto-Commenter)
// @namespace    http://instatakker.io
// @version      1.0.0
// @description  Automated Comment Liking with Shadow DOM UI
// @author       Instatakker
// @match        https://www.instagram.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  let running = false;
  const st = {
    total: 0,
    scans: 0,
    lastUrl: location.href
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function injectShadowUI() {
    if (document.getElementById('itk-host')) return;
    const host = document.createElement('div');
    host.id = 'itk-host';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const root = document.createElement('div');
    
    root.innerHTML = `
      <style>
        #panel { position: fixed; bottom: 20px; left: 20px; z-index: 2147483647; width: 300px; background: #050505; border: 2px solid #ff0055; border-radius: 12px; padding: 15px; color: #ff0055; font-family: monospace; box-shadow: 0 0 20px rgba(255,0,85,.35); }
        .title { font-weight: bold; border-bottom: 1px solid #333; padding-bottom: 8px; margin-bottom: 8px; }
        .stat-box { background: #111; padding: 8px; margin: 6px 0; border: 1px solid #333; border-radius: 6px; }
        #status { text-align: center; font-weight: bold; color: #fff; }
        #log { font-size: 11px; color: #aaa; margin-top: 10px; line-height: 1.35; height: 30px; overflow: hidden; }
      </style>
      <div id="panel">
        <div class="title">INSTATAKKER BEAST v1.0.0</div>
        <div id="status" class="stat-box">STANDBY</div>
        <div class="stat-box">COMMENTS LIKED: <span id="count-l">0</span></div>
        <div id="log">PRESS ENTER TO UNLEASH</div>
      </div>
    `;
    shadow.appendChild(root);

    window.updateBeastUI = d => {
      if (d.total !== undefined) shadow.querySelector('#count-l').textContent = d.total;
      if (d.log) shadow.querySelector('#log').textContent = d.log;
      if (d.status) shadow.querySelector('#status').textContent = d.status;
    };
  }

  async function autoCommentLicker() {
    while (running) {
      // 1. Expand comments if the "Load More" (line SVG) exists
      const loadMore = document.querySelector('svg line[x1="7.001"]')?.closest('button');
      if (loadMore) {
        window.updateBeastUI({ log: "EXPANDING COMMENT THREADS..." });
        loadMore.click();
        await sleep(rand(2000, 3500));
      }

      // 2. Identify Likable Comments (Filtering out already liked ones)
      const hearts = [...document.querySelectorAll('ul svg[aria-label="Like"]')];
      
      if (hearts.length === 0) {
        window.updateBeastUI({ log: "SEARCHING FOR TARGETS..." });
        window.scrollBy(0, 300);
        await sleep(2000);
        continue;
      }

      for (let heart of hearts) {
        if (!running) break;

        // Ensure we are in a comment list, not the main post heart
        const commentContainer = heart.closest('ul');
        if (commentContainer) {
          const btn = heart.closest('button');
          if (btn) {
            btn.click();
            st.total++;
            window.updateBeastUI({ 
                total: st.total, 
                log: `LIKED COMMENT #${st.total}` 
            });

            // Cooldown logic to avoid "Action Blocked"
            if (st.total % 40 === 0) {
              window.updateBeastUI({ status: "RESTING", log: "COOLING DOWN 3 MINS..." });
              await sleep(180000); 
              window.updateBeastUI({ status: "BEAST ACTIVE" });
            }

            // Random human-like delay
            await sleep(rand(3500, 8500));
          }
        }
      }
      
      // Infinite scroll trigger
      window.scrollBy(0, 500);
      await sleep(2000);
    }
  }

  function setupHotkeys() {
    window.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        running = !running;
        window.updateBeastUI({
          status: running ? '!!! BEAST ACTIVE !!!' : 'STOPPED',
          log: running ? 'AUTOPILOT ENGAGED' : 'SYSTEM DISENGAGED'
        });
        if (running) autoCommentLicker();
      }
    });
  }

  // Init
  (async function boot() {
    while(!document.body) await sleep(100);
    injectShadowUI();
    setupHotkeys();
    console.log("%c BEAST v1.0.0 LOADED ", "background:#ff0055; color:white;");
  })();
})();
