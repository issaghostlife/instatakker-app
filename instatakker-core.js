// ==UserScript==
// @name         Instatakker v4 BEAST (CSP BYPASS)
// @namespace    http://instatakker.io
// @version      1.0.5
// @description  Bypasses Instagram Security Policy with Shadow DOM
// @author       Instatakker
// @match        https://www.instagram.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';

  // ========================================================================
  //  SILENT INJECTION LOGIC (Bypasses "Injection Failed")
  // ========================================================================
  
  let running = false;
  let mode = 'like';
  const st = { total: 0, posts: 0, comments: 0, unfollowed: 0 };
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Fingerprint Spoofing
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // ========================================================================
  //  SHADOW UI (Invisible to IG's security scanners)
  // ========================================================================

  function injectShadowUI() {
    if (document.getElementById('itk-host')) return;

    const host = document.createElement('div');
    host.id = 'itk-host';
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: 'closed' }); // Closed mode = hidden from page scripts
    const root = document.createElement('div');
    
    root.innerHTML = `
      <style>
        #panel {
          position: fixed; bottom: 20px; left: 20px; z-index: 2147483647;
          width: 300px; background: #000; border: 2px solid #00ffcc;
          border-radius: 12px; padding: 15px; color: #00ffcc;
          font-family: 'Courier New', monospace; box-shadow: 0 0 20px rgba(0,255,204,0.3);
        }
        .stat-box { background: #111; padding: 10px; border-radius: 5px; margin: 5px 0; border: 1px solid #222; }
        .btn-status { color: #fff; text-shadow: 0 0 5px #00ffcc; font-weight: bold; }
        #log { font-size: 10px; height: 35px; overflow: hidden; color: #888; margin-top: 10px; border-top: 1px solid #333; padding-top: 5px; }
      </style>
      <div id="panel">
        <div style="font-size: 14px; margin-bottom: 10px; border-bottom: 1px solid #222;">SYSTEM: BEAST CORE v4.0.5</div>
        <div id="status" class="stat-box" style="text-align:center;">[ ENTER ] TO UNLEASH</div>
        <div class="stat-box">LIKES: <span id="count-l">0</span></div>
        <div class="stat-box">UNFOLLOWS: <span id="count-u">0</span></div>
        <div id="log">SYSTEM READY... STANDBY</div>
        <div style="font-size:9px; color:#555; margin-top:5px;">ENTER: Toggle | TAB: Mode</div>
      </div>
    `;

    shadow.appendChild(root);

    // Update function accessible via closure
    window.updateBeastUI = (data) => {
        shadow.querySelector('#count-l').textContent = data.total;
        shadow.querySelector('#count-u').textContent = data.unfollowed;
        if(data.log) shadow.querySelector('#log').textContent = data.log;
        if(data.status) shadow.querySelector('#status').textContent = data.status;
    };
  }

  // ========================================================================
  //  BEAST ACTIONS
  // ========================================================================

  async function beastLoop() {
    while (running) {
      if (mode === 'like') {
        // Find Post
        const post = document.querySelector('article a[href*="/p/"]');
        if (!document.querySelector('div[role="dialog"]') && post) {
          post.click();
          await sleep(3000);
        }

        // Like Main Heart
        const heart = document.querySelector('section span svg[aria-label="Like"]');
        if (heart) {
          heart.closest('button').click();
          st.total++;
          window.updateBeastUI({ total: st.total, log: "Target Neutralized (Like)" });
          await sleep(rand(2000, 4000));
        }

        // Like Comments (Deep Scan)
        const comments = [...document.querySelectorAll('ul ul svg[aria-label="Like"]')];
        for (let c of comments.slice(0, 15)) { // First 15 visible comments
          if(!running) break;
          c.closest('button').click();
          st.total++;
          window.updateBeastUI({ total: st.total, log: "Comment Nuked" });
          await sleep(rand(1000, 2000));
        }

        // Move to next
        const next = document.querySelector('svg[aria-label="Next"]');
        if (next) {
            next.closest('button').click();
            await sleep(rand(3000, 5000));
        } else {
            document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
            window.scrollBy(0, 800);
            await sleep(3000);
        }

      } else {
        // Unfollow Logic
        const unf_btn = [...document.querySelectorAll('button')].find(b => b.innerText === 'Following');
        if (unf_btn) {
            unf_btn.click(); await sleep(1000);
            const conf = [...document.querySelectorAll('button')].find(b => b.innerText === 'Unfollow');
            if(conf) { conf.click(); st.unfollowed++; window.updateBeastUI({ unfollowed: st.unfollowed, log: "User Dropped" }); }
        } else { window.scrollBy(0, 500); }
        await sleep(rand(4000, 7000));
      }
    }
  }

  // ========================================================================
  //  INPUT CONTROLLER
  // ========================================================================

  window.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        running = !running;
        window.updateBeastUI({ 
            status: running ? "!!! BEAST ACTIVE !!!" : "[ ENTER ] TO START",
            log: running ? "CORE ENGAGED" : "CORE DISENGAGED" 
        });
        if (running) beastLoop();
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        mode = mode === 'like' ? 'unfollow' : 'like';
        window.updateBeastUI({ log: `MODE: ${mode.toUpperCase()}` });
    }
  });

  // Delayed start to ensure DOM is ready
  setTimeout(injectShadowUI, 2000);
  console.log("%c BEAST v4.0.5 SHADOW CORE INJECTED ", "background: #000; color: #00ffcc; font-weight: bold;");

})();
