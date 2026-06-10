// ==UserScript==
// @name         Instatakker v1.0.0 BEAST
// @namespace    http://instatakker.io
// @version      1.0.0
// @description  Targeted Comment Liking with Rate Limit Handling
// @author       Instatakker
// @match        https://www.instagram.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';

  let running = false;
  const st = { total: 0, cooldown: false };
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function injectShadowUI() {
    if (document.getElementById('itk-host')) return;
    const host = document.createElement('div');
    host.id = 'itk-host';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    const root = document.createElement('div');
    root.innerHTML = `
      <style>
        #panel { position: fixed; bottom: 20px; left: 20px; z-index: 2147483647; width: 280px; background: #000; border: 2px solid #ff0055; border-radius: 12px; padding: 15px; color: #ff0055; font-family: monospace; }
        .stat-box { background: #111; padding: 8px; margin: 5px 0; border: 1px solid #333; }
        #log { font-size: 11px; color: #aaa; margin-top: 10px; }
      </style>
      <div id="panel">
        <div style="font-weight:bold; border-bottom:1px solid #333;">BEAST CORE v1.0.0</div>
        <div id="status" class="stat-box" style="text-align:center;">STOPPED</div>
        <div class="stat-box">LIKES: <span id="count-l">0</span></div>
        <div id="log">PRESS ENTER TO START</div>
      </div>
    `;
    shadow.appendChild(root);
    window.updateBeastUI = (d) => {
        if(d.total !== undefined) shadow.querySelector('#count-l').textContent = d.total;
        if(d.log) shadow.querySelector('#log').textContent = d.log;
        if(d.status) shadow.querySelector('#status').textContent = d.status;
    };
  }

  async function beastLoop() {
    while (running) {
      // 1. Check for "Load More" button (the line SVG you provided)
      const loadMoreBtn = document.querySelector('svg line[x1="7.001"]')?.closest('button');
      if (loadMoreBtn) {
        window.updateBeastUI({ log: "EXPANDING THREADS..." });
        loadMoreBtn.click();
        await sleep(rand(2000, 3000));
      }

      // 2. Find all heart SVGs
      // We filter out those that are already "Unlike" (meaning already liked)
      const allHearts = [...document.querySelectorAll('ul svg[aria-label="Like"]')];
      
      if (allHearts.length === 0) {
        window.updateBeastUI({ log: "NO LIKABLE COMMENTS FOUND" });
        window.scrollBy(0, 400);
        await sleep(3000);
        continue;
      }

      for (let heart of allHearts) {
        if (!running) break;

        // Check if we hit a rate limit (common indicators: UI stops responding or popup appears)
        if (st.total > 0 && st.total % 50 === 0) {
            window.updateBeastUI({ status: "COOLDOWN ACTIVE", log: "WAITING 5 MINUTES..." });
            await sleep(300000); // 5 minute safety wait every 50 likes
            window.updateBeastUI({ status: "!!! ACTIVE !!!" });
        }

        // Verify it isn't the main post heart (filtering by size or parent)
        const isCommentHeart = heart.closest('ul');
        
        if (isCommentHeart) {
            heart.closest('button').click();
            st.total++;
            window.updateBeastUI({ total: st.total, log: "COMMENT LIKED" });
            
            // Random delay between 3-7 seconds per comment to mimic human behavior
            await sleep(rand(3000, 7000));
        }
      }
      
      // Scroll to trigger lazy loading of more comments
      window.scrollBy(0, 500);
      await sleep(2000);
    }
  }

  window.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        running = !running;
        window.updateBeastUI({ 
            status: running ? "!!! ACTIVE !!!" : "STOPPED",
            log: running ? "CORE ENGAGED" : "CORE DISENGAGED" 
        });
        if (running) beastLoop();
    }
  });

  setTimeout(injectShadowUI, 2000);
})();
