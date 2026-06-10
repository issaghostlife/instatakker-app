// ==UserScript==
// @name         Instatakker Core Pro
// @namespace    http://instatakker.io
// @version      1.0.0
// @description  Professional IG Automation Core — Unfollow, Like, Auto-Comment, and Like-Back
// @author       Instatakker
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const VERSION = '1.0.0';

    // ======================== CONFIG & DEFAULTS ========================
    const DEFAULTS = {
        unfollow: { max: 100, minDelay: 8000, maxDelay: 15000, hourly: 60 },
        like:     { max: 500, minDelay: 4000, maxDelay: 9000,  hourly: 200, commentChance: 0.15 },
        likeBack: { enabled: true, maxPerSession: 20 },
        comments: [
            "{🔥|🙌|👏} {Love this!|Great post!|Amazing.}",
            "This is {awesome|incredible}! {Keep it up.|Love your content.}",
            "{So cool|Vibes}! 🙌",
            "ayee litt! {👏|🔥}"
        ]
    };

    let config = JSON.parse(JSON.stringify(DEFAULTS));
    let running = false, stopped = false, mode = 'like';
    let state = {
        unfollowed: 0, liked: 0, comments: 0, engaged: 0,
        hourlyCount: 0, hourlyReset: Date.now(), errors: 0
    };

    // ======================== UTILITIES ========================
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const log = msg => console.log(`%c[Instatakker] ${msg}`, "color: #ff0050; font-weight: bold;");

    function spintax(text) {
        return text.replace(/{([^{}]+)}/g, (_, options) => {
            const choices = options.split('|');
            return choices[rand(0, choices.length - 1)];
        });
    }

    // ======================== ADAPTIVE LEARNING & SESSIONS ========================
    const LKEY = `itk_profile_${window.location.pathname.split('/')[1] || 'default'}`;
    let profile = JSON.parse(localStorage.getItem(LKEY)) || { blocks: 0, sessionCount: 0, learnedLimit: 100 };

    function saveProfile() {
        localStorage.setItem(LKEY, JSON.stringify(profile));
    }

    const sessionSeed = Math.abs(Date.now() ^ 0xFFFF);
    const getSessionBias = () => (0.85 + (sessionSeed % 100 / 333)); // Unique speed for this session

    // ======================== DOM SELECTORS ========================
    const selectors = {
        likeBtn: 'svg[aria-label="Like"]',
        commentBox: 'textarea[aria-label="Add a comment…"]',
        postLinks: 'article a[href*="/p/"], article a[href*="/reel/"]',
        nextArrow: 'svg[aria-label="Next"]',
        closeBtn: 'svg[aria-label="Close"]',
        followingBtn: 'button:nth-child(n) div:nth-child(n)' // Dynamic check for "Following"
    };

    // ======================== CORE ACTIONS ========================

    async function checkHealth() {
        if (Math.random() > 0.1) return; // Only check 10% of the time to save data
        try {
            const res = await fetch(window.location.origin);
            if (res.status === 429) {
                log("IP Rate Limited. Stopping.");
                running = false;
                stopped = true;
                return false;
            }
        } catch (e) { return true; }
        return true;
    }

    async function performLike() {
        const heart = document.querySelector(selectors.likeBtn);
        if (!heart) return false;
        const btn = heart.closest('button');
        if (btn) {
            btn.click();
            state.liked++;
            state.hourlyCount++;
            return true;
        }
        return false;
    }

    async function performComment() {
        if (Math.random() > config.like.commentChance) return false;
        const box = document.querySelector(selectors.commentBox);
        if (!box) return false;

        const text = spintax(config.comments[rand(0, config.comments.length - 1)]);
        box.value = text;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1000);

        const submit = [...document.querySelectorAll('div[role="button"]')].find(el => el.innerText === "Post");
        if (submit) {
            submit.click();
            state.comments++;
            return true;
        }
        return false;
    }

    async function performUnfollow() {
        const btns = [...document.querySelectorAll('button')].filter(b => b.innerText === 'Following');
        if (!btns.length) return false;

        btns[0].click();
        await sleep(rand(1000, 2000));
        const confirm = [...document.querySelectorAll('button')].find(b => b.innerText === 'Unfollow');
        if (confirm) {
            confirm.click();
            state.unfollowed++;
            state.hourlyCount++;
            return true;
        }
        return false;
    }

    async function performLikeBack() {
        if (!config.likeBack.enabled || window.location.pathname.includes('/p/')) return;
        log("Checking Activity for Like-Back...");
        const activityBtn = document.querySelector('a[href="/accounts/activity/"]');
        if (activityBtn) {
            activityBtn.click();
            await sleep(4000);
            const likes = [...document.querySelectorAll('span')].filter(s => s.innerText.includes('liked your photo')).slice(0, 3);
            for (const item of likes) {
                item.click();
                await sleep(3000);
                await performLike();
                window.history.back();
                await sleep(2000);
            }
        }
    }

    // ======================== MAIN ENGINE ========================

    async function mainLoop() {
        profile.sessionCount++;
        saveProfile();

        while (running && !stopped) {
            // 1. Reset Hourly Limit
            if (Date.now() - state.hourlyReset > 3600000) {
                state.hourlyCount = 0;
                state.hourlyReset = Date.now();
                log("Hourly Refresh.");
            }

            // 2. Health & Cap Checks
            if (!await checkHealth()) break;
            const currentCap = mode === 'unfollow' ? config.unfollow.hourly : profile.learnedLimit;
            if (state.hourlyCount >= currentCap) {
                log("Hourly cap hit. Resting 10 mins.");
                await sleep(600000);
                continue;
            }

            // 3. Mode Logic
            if (mode === 'unfollow') {
                const success = await performUnfollow();
                if (success) {
                    await sleep(rand(config.unfollow.minDelay, config.unfollow.maxDelay) * getSessionBias());
                } else {
                    window.scrollBy(0, 500);
                    await sleep(3000);
                }
            }
            else if (mode === 'like') {
                // Like-Back Injection
                if (state.engaged % 10 === 0 && state.engaged !== 0) await performLikeBack();

                // Find and Open Post
                if (!document.querySelector('div[role="dialog"]')) {
                    const posts = document.querySelectorAll(selectors.postLinks);
                    if (posts.length) {
                        posts[rand(0, Math.min(posts.length - 1, 5))].click();
                        await sleep(3000);
                    } else {
                        window.scrollBy(0, 800);
                        await sleep(2000);
                        continue;
                    }
                }

                // Interaction
                await performLike();
                await sleep(rand(1000, 3000));
                await performComment();
                state.engaged++;
                updateUI();

                // Navigation
                const next = document.querySelector(selectors.nextArrow);
                if (next) {
                    next.closest('button').click();
                    await sleep(rand(config.like.minDelay, config.like.maxDelay) * getSessionBias());
                } else {
                    const close = document.querySelector(selectors.closeBtn);
                    if (close) close.closest('button').click();
                    window.scrollBy(0, 1000);
                    await sleep(3000);
                }
            }

            // Adaptive Learning update
            if (state.hourlyCount > profile.learnedLimit) {
                profile.learnedLimit = state.hourlyCount;
                saveProfile();
            }
        }
        running = false;
        updateUI();
    }

    // ======================== UI (INLINE PANEL) ========================
    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'itk-core-panel';
        panel.style = `position:fixed; left:20px; top:100px; z-index:10000; width:280px; background:#000; color:#fff; border:1px solid #ff0050; border-radius:8px; padding:15px; font-family:sans-serif; box-shadow: 0 0 15px rgba(255,0,80,0.3);`;
        panel.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <b style="color:#ff0050">INSTATAKKER CORE</b>
                <small style="opacity:0.5">v${VERSION}</small>
            </div>
            <div style="display:flex; gap:5px; margin-bottom:10px;">
                <button id="btn-mode-like" style="flex:1; background:#ff0050; color:white; border:none; padding:5px; border-radius:4px; cursor:pointer">LIKE</button>
                <button id="btn-mode-unf" style="flex:1; background:#222; color:white; border:none; padding:5px; border-radius:4px; cursor:pointer">UNFOLLOW</button>
            </div>
            <div id="stats" style="font-size:12px; background:#111; padding:8px; border-radius:4px;">
                Likes: <span id="s-like">0</span> | Unfollows: <span id="s-unf">0</span><br>
                Comments: <span id="s-comm">0</span> | Hourly: <span id="s-hr">0</span>
            </div>
            <div id="status-text" style="font-size:10px; margin-top:8px; color:#888; text-align:center;">Press ENTER to start/stop</div>
        `;
        document.body.appendChild(panel);

        document.getElementById('btn-mode-like').addEventListener('click', () => { mode = 'like'; updateUI(); });
        document.getElementById('btn-mode-unf').addEventListener('click', () => { mode = 'unfollow'; updateUI(); });
    }

    function updateUI() {
        const l = document.getElementById('s-like'), u = document.getElementById('s-unf'),
              c = document.getElementById('s-comm'), h = document.getElementById('s-hr'),
              st = document.getElementById('status-text');

        if (l) l.innerText = state.liked;
        if (u) u.innerText = state.unfollowed;
        if (c) c.innerText = state.comments;
        if (h) h.innerText = state.hourlyCount;

        if (st) st.innerText = running ? "▶ RUNNING" : "⏹ STOPPED";
        const bL = document.getElementById('btn-mode-like'), bU = document.getElementById('btn-mode-unf');
        if (bL) bL.style.background = mode === 'like' ? '#ff0050' : '#222';
        if (bU) bU.style.background = mode === 'unfollow' ? '#ff0050' : '#222';
    }

    // ======================== LISTENERS ========================
    document.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (running) { stopped = true; running = false; }
            else { running = true; stopped = false; mainLoop(); }
            updateUI();
        }
    });

    createPanel();
    log(`Core Ready. Seed: ${sessionSeed}`);
})();
