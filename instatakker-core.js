// ==UserScript==
// @name         Instatakker
// @namespace    http://instatakker.io
// @version      1.0.0
// @description  Instagram automation — unfollow + like everything (posts + comments) with adaptive learning
// @author       Instatakker
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  const VERSION = '1.0.0';

  // ========================================================================
  //  CONFIG
  // ========================================================================

  const DEFAULTS = {
    unfollow: {
      maxUnfollows: 100,
      minDelay: 8000,
      maxDelay: 14000,
      scrollWait: 5000,
      hourlyLimit: 60,
      emptyRoundsBeforeStop: 8,
    },
    like: {
      maxLikes: 500,
      minDelay: 3000,
      maxDelay: 8000,
      hourlyLimit: 200,
      emptyRoundsBeforeStop: 5,
      maxCommentsPerPost: 200,
      minCommentDelay: 1200,
      maxCommentDelay: 3500,
    },
  };

  const cfg = {
    unfollow: { ...DEFAULTS.unfollow },
    like:   { ...DEFAULTS.like },
  };

  let running = false;
  let stopped = false;
  let mode = 'unfollow';

  const st = {
    unfollowed: 0,
    liked: 0,
    commentsLiked: 0,
    postsEngaged: 0,
    startTime: null,
    hourlyCount: 0,
    hourlyReset: Date.now(),
    emptyRounds: 0,
    consecutiveErrors: 0,
  };

  // ---------- helpers ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const log = msg => console.log(`[Instatakker v${VERSION}] ${msg}`);

  // ---------- human-like delay patterns ----------
  function humanDelay(baseMin, baseMax) {
    const r = Math.random();
    if (r < 0.08) return rand(5000, 12000);   // "reading" pause
    if (r < 0.12) return rand(10000, 25000);  // "distracted" pause
    const d = rand(baseMin, baseMax);
    return Math.round(d * (0.85 + Math.random() * 0.3));
  }

  async function humanScroll(dist) {
    const steps = Math.ceil(dist / 200);
    for (let i = 0; i < Math.min(steps, 8); i++) {
      if (stopped || !running) break;
      window.scrollBy(0, rand(150, 350));
      await sleep(rand(200, 600));
    }
  }

  async function humanHover() {
    await sleep(rand(150, 900));
  }

  // ========================================================================
  //  ADAPTIVE LEARNING ENGINE
  // ========================================================================

  function accountKey() {
    try {
      const m = document.querySelector('meta[property="og:url"]');
      if (m) {
        const u = m.getAttribute('content');
        const x = u.match(/instagram\.com\/([^\/\?#]+)/);
        if (x) return `itk_${x[1]}`;
      }
      const p = window.location.pathname.split('/')[1];
      if (p && p.length < 50) return `itk_${p}`;
    } catch (_) { /* skip */ }
    return 'itk_default';
  }
  const LKEY = accountKey();

  function loadProfile() {
    try {
      const raw = localStorage.getItem(LKEY);
      if (raw) {
        const p = JSON.parse(raw);
        log(`📂 Loaded profile — ${p.sessions} sessions, ${p.blocks} blocks`);
        return p;
      }
    } catch (_) { /* ignore */ }
    return {
      blocks: 0,
      blockHistory: [],
      sessions: 0,
      maxSafeHourly: 0,
      maxSafePerPost: 0,
      learnedHourlyCap: 200,
      learnedPerPostCap: 150,
      // fingerprint-like session tracking
      screenW: screen.width,
      screenH: screen.height,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lastSession: null,
    };
  }

  let profile = loadProfile();
  profile.sessions++;

  function saveProfile() {
    try {
      profile.lastSession = Date.now();
      localStorage.setItem(LKEY, JSON.stringify(profile));
    } catch (_) { /* ignore */ }
  }

  function recordBlock(action) {
    profile.blocks++;
    profile.blockHistory.push({
      action, hourlyCount: st.hourlyCount, total: st.liked + st.unfollowed,
      ts: Date.now(),
    });
    if (profile.blockHistory.length > 20) profile.blockHistory = profile.blockHistory.slice(-20);

    const recent = profile.blockHistory.slice(-5);
    if (recent.length >= 2) {
      const avg = Math.round(recent.reduce((s, b) => s + b.hourlyCount, 0) / recent.length);
      profile.learnedHourlyCap = Math.max(40, Math.round(avg * 0.65));  // more conservative margin
      profile.learnedPerPostCap = Math.max(15, Math.round(profile.learnedHourlyCap / 4));
      log(`🧠 Blocked at ${st.hourlyCount}/hr → learned cap: ${profile.learnedHourlyCap}/hr, ${profile.learnedPerPostCap}/post`);
    }
    saveProfile();
  }

  function recordSafe() {
    if (st.hourlyCount > profile.maxSafeHourly) {
      profile.maxSafeHourly = st.hourlyCount;
      const avg = st.postsEngaged > 0 ? Math.round(st.commentsLiked / st.postsEngaged) : 0;
      profile.maxSafePerPost = Math.max(profile.maxSafePerPost, avg);
      saveProfile();
    }
  }

  function safeLimits() {
    if (profile.blocks >= 2) {
      return {
        hourly: Math.min(cfg.like.hourlyLimit, Math.max(
          profile.maxSafeHourly + 8,
          profile.learnedHourlyCap
        )),
        perPost: Math.min(cfg.like.maxCommentsPerPost, Math.max(
          profile.maxSafePerPost + 3,
          profile.learnedPerPostCap
        )),
      };
    }
    // new account — conservative
    return { hourly: Math.min(cfg.like.hourlyLimit, 80), perPost: Math.min(cfg.like.maxCommentsPerPost, 40) };
  }

  // ========================================================================
  //  USER AGENT & FINGERPRINT SPOOFING (session-level)
  // ========================================================================

  /**
   * Generate a session fingerprint hash used to seed random-like behavior.
   * Every session gets a slightly different "personality".
   */
  function sessionFingerprint() {
    const seed = [
      Date.now() & 0xFFFF,
      Math.random() * 1000,
      profile.sessions,
      screen.width,
      screen.height,
      navigator.hardwareConcurrency || 4,
    ].join('|');
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = ((h << 5) - h) + seed.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  const FP = sessionFingerprint();

  /**
   * Seeded pseudo-random number generator (mulberry32).
   * Each session gets deterministic but unique behavior patterns.
   */
  function seededRand() {
    let s = FP + 1;
    return function() {
      s |= 0;
      s = s + 0x6D2B79F5 | 0;
      let t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const srand = seededRand();

  /**
   * Session-level behavioral parameters (rotated each session).
   * Makes the bot behave differently every time — harder to fingerprint.
   */
  const BEHAVIOR = {
    scrollSpeed: 150 + Math.floor(srand() * 300),       // 150-450 px per step
    pauseChance: 0.05 + srand() * 0.12,                  // 5-17% chance of extra pause
    distractionChance: 0.02 + srand() * 0.08,            // 2-10% chance of long pause
    microPauseMin: 50 + Math.floor(srand() * 150),       // 50-200ms
    microPauseMax: 150 + Math.floor(srand() * 300),      // 150-450ms
    burstSize: 2 + Math.floor(srand() * 5),              // 2-6 actions before micro-break
    burstBreak: 2000 + Math.floor(srand() * 6000),       // 2-8s break after burst
    clickJitter: Math.floor(srand() * 6),                // 0-5 extra ms jitter
  };

  /**
   * HUMAN-like delay with session-level variance.
   */
  function adaptiveDelay(baseMin, baseMax) {
    const r = Math.random();
    if (r < BEHAVIOR.pauseChance) {
      return rand(baseMin + 2000, baseMax + 5000);           // "reading" pause
    }
    if (r < BEHAVIOR.pauseChance + BEHAVIOR.distractionChance) {
      return rand(8000, 22000);                               // "distracted" pause
    }
    // Session-specific speed bias
    const bias = 0.85 + srand() * 0.3;
    return Math.round(rand(baseMin, baseMax) * bias);
  }

  /**
   * Micro-actions within a burst — fast but varied.
   */
  async function microAction() {
    await sleep(rand(BEHAVIOR.microPauseMin, BEHAVIOR.microPauseMax));
  }

  let _burstCounter = 0;

  async function burstCheck() {
    _burstCounter++;
    if (_burstCounter >= BEHAVIOR.burstSize) {
      _burstCounter = 0;
      await sleep(rand(
        BEHAVIOR.burstBreak,
        BEHAVIOR.burstBreak + 4000
      ));
    }
  }

  // ========================================================================
  //  DOM HELPERS — Instagram-specific
  // ========================================================================

  /** Get the currently visible article elements in the feed */
  function feedArticles() {
    return [...document.querySelectorAll('article')].filter(a => {
      const rect = a.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    });
  }

  /** Find a "Like" heart SVG inside a container that is NOT already liked */
  function findLikeButton(container = document) {
    // aria-label="Like" (not "Unlike")
    const svgs = [...container.querySelectorAll('svg[aria-label="Like"]')];
    // Filter out comment hearts — we want the post heart
    // Post heart is usually inside the main article action bar
    for (const svg of svgs) {
      const section = svg.closest('section');
      if (section && section.closest('article')) return svg;
    }
    return svgs.find(s => s.closest('article')) || svgs[0] || null;
  }

  /** Click a like button element */
  function clickLike(el) {
    if (!el) return false;
    const btn = el.closest('button') || el.closest('[role="button"]') || el.parentElement;
    if (!btn) return false;
    btn.click();
    return true;
  }

  /** Click "Load more comments" button */
  function clickLoadMore() {
    const svg = document.querySelector('svg[aria-label="Load more comments"]');
    if (!svg) return false;
    const btn = svg.closest('button') || svg.closest('[role="button"]') || svg.parentElement;
    if (!btn) return false;
    btn.click();
    return true;
  }

  /** Get all comment Like buttons that are currently unliked */
  function unlikedCommentButtons() {
    const seen = new Set();
    const all = [...document.querySelectorAll('ul ul svg[aria-label="Like"]')];
    return all.filter(svg => {
      const li = svg.closest('li');
      if (!li || seen.has(li)) return false;
      seen.add(li);
      return true;
    });
  }

  /** Click a comment like button */
  function clickCommentLike(svg) {
    const btn = svg.closest('button') || svg.closest('[role="button"]') || svg.parentElement;
    if (!btn) return false;
    btn.click();
    return true;
  }

  /** Scroll the comments dialog/list */
  function scrollComments() {
    // Try scrolling the dialog
    const dialog = document.querySelector('div[role="dialog"]');
    if (dialog) {
      const scrollables = [...dialog.querySelectorAll('div')].filter(d => {
        try { return d.scrollHeight > d.clientHeight + 30; } catch(_) { return false; }
      });
      if (scrollables.length) {
        scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight)[0].scrollTop += 500;
        return true;
      }
    }
    // Try direct comment list
    const uls = [...document.querySelectorAll('ul')].filter(ul => {
      try { return ul.scrollHeight > ul.clientHeight + 20; } catch(_) { return false; }
    });
    if (uls.length) { uls[0].scrollTop = uls[0].scrollHeight; return true; }
    return false;
  }

  /** Is the post dialog open? */
  function inPostView() {
    return !!document.querySelector('div[role="dialog"] article');
  }

  /** Click the "Next" arrow to go to the next post */
  function goNextPost() {
    try {
      // Primary: SVG with aria-label="Next" → Instagram's next post arrow
      const nextSvg = document.querySelector('svg[aria-label="Next"]');
      if (nextSvg) {
        const btn = nextSvg.closest('button');
        if (btn) { btn.click(); return true; }
      }
      // Fallback: look for the right-arrow button inside the dialog
      const dialog = document.querySelector('div[role="dialog"]');
      if (dialog) {
        const arrows = [...dialog.querySelectorAll('button')].filter(b => {
          return b.querySelector('svg[aria-label="Next"]') ||
                 (b.innerHTML.includes('Next') && b.offsetParent !== null);
        });
        if (arrows.length) { arrows[0].click(); return true; }
      }
    } catch(_) { /* ignore */ }
    return false;
  }

  /** Close the current post dialog */
  function closePost() {
    const closeSvg = document.querySelector('svg[aria-label="Close"]');
    if (closeSvg) {
      const btn = closeSvg.closest('button') || closeSvg.parentElement;
      if (btn) { btn.click(); return true; }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
    return true;
  }

  // ========================================================================
  //  UNFOLLOW ENGINE
  // ========================================================================

  function getFollowingBtns() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return [];
    return [...dialog.querySelectorAll('button')].filter(b => {
      if (!b.offsetParent) return false;
      return (b.textContent || '').trim() === 'Following';
    });
  }

  function clickUnfollowConfirm() {
    const btn = [...document.querySelectorAll('button')].find(b => {
      if (!b.offsetParent) return false;
      return (b.textContent || '').trim() === 'Unfollow';
    });
    if (btn) { btn.click(); return true; }
    return false;
  }

  function scrollFollowing() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return false;
    const scrollables = [...dialog.querySelectorAll('div')].filter(d => {
      try { return d.scrollHeight > d.clientHeight + 30; } catch(_) { return false; }
    });
    if (scrollables.length) {
      scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight)[0].scrollTop += 800;
      return true;
    }
    return false;
  }

  // ========================================================================
  //  LIKE ENGINE — FEED MODE (processes all visible posts)
  // ========================================================================

  /**
   * Like ALL comments on the current post dialog.
   * Returns number of comments liked.
   */
  async function likeAllComments(logEl) {
    let liked = 0;
    let roundsWithNothing = 0;
    let prevCount = 0;
    const lim = safeLimits();

    for (let r = 0; r < 80; r++) {
      if (stopped || !running) break;
      if (st.hourlyCount >= lim.hourly) {
        recordBlock('hourly_cap_comments');
        break;
      }

      // 1. Load more comments
      const loaded = clickLoadMore();
      if (loaded) {
        await sleep(rand(1200, 2500));
        if (logEl) logEl.textContent = `📄 Loading more comments... (${liked} liked)`;
      }

      // 2. Scroll
      scrollComments();
      await sleep(rand(800, 1800));

      // 3. Like unliked comments
      const btns = unlikedCommentButtons();
      if (btns.length > 0) {
        roundsWithNothing = 0;
        for (const svg of btns) {
          if (stopped || !running) break;
          if (!document.contains(svg)) continue;
          if (st.hourlyCount >= lim.hourly) {
            recordBlock('hourly_cap_mid_comment');
            break;
          }

          await humanHover();
          await microAction();

          if (clickCommentLike(svg)) {
            liked++;
            st.liked++;
            st.hourlyCount++;
            st.commentsLiked++;
            if (logEl) logEl.textContent = `💬 Liked ${liked} comments (total: ${st.liked})`;

            // Use adaptive human delay
            await sleep(adaptiveDelay(
              cfg.like.minCommentDelay,
              cfg.like.maxCommentDelay
            ));
          } else {
            st.consecutiveErrors++;
            if (st.consecutiveErrors > 5) {
              await sleep(10000);
              st.consecutiveErrors = 0;
            }
            await sleep(500);
          }
        }
      } else {
        roundsWithNothing++;
        if (roundsWithNothing >= 3 && !loaded) {
          log(`✅ All ${liked} comments liked on this post`);
          break;
        }
        await sleep(rand(1500, 3500));
      }
    }

    st.postsEngaged++;
    return liked;
  }

  /**
   * Process one post: like it + like all its comments.
   * Returns { liked, comments }.
   */
  async function processPost(logEl, statusEl) {
    if (stopped || !running) return { liked: false, comments: 0 };

    // ---- Like the post ----
    const likeSvg = findLikeButton();
    const postLiked = likeSvg && clickLike(likeSvg);

    if (postLiked) {
      st.liked++;
      st.hourlyCount++;
      st.postsEngaged++;
      if (logEl) logEl.textContent = `❤️ Liked post ${st.postsEngaged}`;
      if (statusEl) statusEl.textContent = `❤️${st.liked}`;
      log(`Liked post #${st.postsEngaged}`);

      // Human pause — "look at the post"
      await sleep(adaptiveDelay(3000, 8000));
    } else {
      if (logEl) logEl.textContent = `📌 Already liked (${st.liked} total)`;
    }

    // ---- Like all comments ----
    if (logEl) logEl.textContent = `💬 Liking comments...`;
    const comments = await likeAllComments(logEl);

    return { liked: postLiked, comments };
  }

  /**
   * Find the next unprocessed post in the feed and open it.
   * Works on the main feed (home, hashtag, profile).
   * Returns true if a post was opened.
   */
  async function openNextPost(logEl) {
    if (stopped || !running) return false;

    // Strategy: look for post links that haven't been processed
    // Instagram uses anchor tags inside articles pointing to /p/...
    let posts = [
      ...document.querySelectorAll('article a[href*="/p/"], article a[href*="/reel/"]'),
    ].filter(a => {
      // Must be visible
      const r = a.getBoundingClientRect();
      return r.width > 0 && r.height > 0 &&
             r.bottom > -100 && r.top < window.innerHeight + 100;
    });

    // Remove duplicates
    const seen = new Set();
    posts = posts.filter(a => {
      const href = a.getAttribute('href');
      if (seen.has(href)) return false;
      seen.add(href);
      return true;
    });

    // If no posts in view, scroll a bit
    if (posts.length === 0) {
      await humanScroll(600);
      await sleep(rand(1000, 2000));
      posts = [...document.querySelectorAll('article a[href*="/p/"], article a[href*="/reel/"]')]
        .filter(a => {
          const r = a.getBoundingClientRect();
          return r.width > 0 && r.height > 0 &&
                 r.bottom > -100 && r.top < window.innerHeight + 100;
        });
      const seen2 = new Set();
      posts = posts.filter(a => {
        const href = a.getAttribute('href');
        if (seen2.has(href)) return false;
        seen2.add(href);
        return true;
      });
    }

    if (posts.length === 0) {
      if (logEl) logEl.textContent = `📭 No posts visible — scrolling...`;
      await humanScroll(window.innerHeight);
      await sleep(rand(1500, 3000));
      return false;
    }

    // Pick a post — not always the first one (human-like)
    const idx = Math.floor(srand() * Math.min(posts.length, 3));
    const post = posts[idx] || posts[0];

    if (logEl) logEl.textContent = `📱 Opening post...`;
    post.click();
    await sleep(rand(2000, 3500));
    return true;
  }

  /**
   * Navigate to the next post using Instagram's built-in arrow.
   * This works when already inside a post dialog.
   */
  async function nextPostViaArrow(logEl) {
    if (goNextPost()) {
      await sleep(rand(2000, 3500));
      return true;
    }

    // If no next arrow, close and scroll to next
    if (logEl) logEl.textContent = `➡️ No next arrow — closing post...`;
    closePost();
    await sleep(rand(1500, 2500));
    await humanScroll(rand(500, 1200));
    await sleep(rand(1500, 3000));
    return false;
  }

  // ========================================================================
  //  MAIN ENGINE
  // ========================================================================

  async function engine() {
    st.startTime = st.startTime || Date.now();
    const logEl  = document.getElementById('itk-log');
    const stEl   = document.getElementById('itk-status');
    const lim    = safeLimits();
    const learned = profile.blocks >= 2;

    // Show session personality
    if (logEl) {
      const personality = ['casual', 'focused', 'browsing', 'scrolling', 'engaged'][FP % 5];
      logEl.textContent = learned
        ? `🧠 ${profile.sessions} sessions · ${lim.hourly}/hr learned · ${personality} mode`
        : `🆕 Building profile · conservative (${lim.hourly}/hr) · ${personality} mode`;
    }
    log(`Session fingerprint: ${FP} | Behavior: ${JSON.stringify(BEHAVIOR)}`);

    while (running && !stopped) {
      // -------- Hourly reset --------
      if (Date.now() - st.hourlyReset > 3600000) {
        st.hourlyCount = 0;
        st.hourlyReset = Date.now();
        log('⏰ Hourly counter reset');
      }

      // -------- Cap check --------
      const cap = mode === 'unfollow' ? cfg.unfollow.hourlyLimit : lim.hourly;
      if (st.hourlyCount >= cap) {
        const wait = 3600000 - (Date.now() - st.hourlyReset);
        const mins = Math.ceil(wait / 60000);
        if (logEl) logEl.textContent = `⏳ Hit cap (${st.hourlyCount}) — wait ${mins}min`;
        if (stEl) { stEl.textContent = `⏳ ${mins}min`; stEl.style.background = '#ff6b9d22'; }
        recordBlock('hourly_cap_reached');

        // Human-like 5-10 min break, then retry
        await sleep(rand(300000, 600000));
        if (st.hourlyCount >= cap) {
          await sleep(Math.min(wait + 5000, 3600000));
        }
        st.hourlyCount = 0;
        st.hourlyReset = Date.now();
        if (stEl) { stEl.style.background = ''; }
        continue;
      }

      const count  = mode === 'unfollow' ? st.unfollowed : st.liked;
      const maxVal = mode === 'unfollow' ? cfg.unfollow.maxUnfollows : cfg.like.maxLikes;
      if (count >= maxVal) {
        if (logEl) logEl.textContent = `✅ ${mode === 'unfollow' ? 'Unfollowed' : 'Liked'} ${count}`;
        updateUI();
        break;
      }

      // ===================== UNFOLLOW =====================
      if (mode === 'unfollow') {
        if (!document.querySelector('div[role="dialog"]')) {
          if (logEl) logEl.textContent = '⚠️ Open the Following list first';
          await sleep(2000);
          continue;
        }

        const btns = getFollowingBtns();
        if (btns.length === 0) {
          st.emptyRounds++;
          if (st.emptyRounds >= cfg.unfollow.emptyRoundsBeforeStop) {
            if (logEl) logEl.textContent = `🏁 Done (${st.unfollowed} unfollowed)`;
            break;
          }
          if (logEl) logEl.textContent = `⚠️ No Following buttons (${st.emptyRounds}/${cfg.unfollow.emptyRoundsBeforeStop})`;
        } else {
          st.emptyRounds = 0;
          st.consecutiveErrors = 0;
          const btn = btns[0];
          if (!document.contains(btn)) continue;
          if ((btn.textContent || '').trim() !== 'Following') continue;

          if (logEl) logEl.textContent = `▶ Unfollowing #${st.unfollowed + 1}...`;
          try { btn.scrollIntoView({ block: 'center' }); } catch(_) {}
          await humanHover();
          await microAction();
          btn.click();
          await sleep(rand(1200, 2500));

          const confirmed = clickUnfollowConfirm();
          if (confirmed) {
            st.unfollowed++;
            st.hourlyCount++;
            updateUI();
            if (stEl) stEl.textContent = `✅${st.unfollowed}`;
            await sleep(adaptiveDelay(cfg.unfollow.minDelay, cfg.unfollow.maxDelay));
          } else {
            // Maybe already unfollowed, maybe UI changed
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Escape', bubbles: true, cancelable: true,
            }));
            await sleep(1500);
            const still = getFollowingBtns().some(b =>
              document.contains(b) && b.textContent.trim() === 'Following' && b === btn
            );
            if (!still) {
              st.unfollowed++;
              st.hourlyCount++;
              updateUI();
              if (stEl) stEl.textContent = `✅${st.unfollowed}`;
              await sleep(adaptiveDelay(cfg.unfollow.minDelay, cfg.unfollow.maxDelay));
            } else {
              if (logEl) logEl.textContent = '⚠️ Cooling 30s...';
              if (stEl) { stEl.textContent = `⚠️`; stEl.style.background = '#ff6b9d22'; }
              await sleep(30000);
              if (stEl) stEl.style.background = '';
            }
          }
          await burstCheck();
        }
        scrollFollowing();
        await sleep(cfg.unfollow.scrollWait);
      }

      // ===================== LIKE =====================
      else {
        // --- Open a post if not already in one ---
        if (!inPostView()) {
          const opened = await openNextPost(logEl);
          if (!opened) {
            st.emptyRounds++;
            if (st.emptyRounds >= cfg.like.emptyRoundsBeforeStop) {
              if (logEl) logEl.textContent = `🏁 No more posts (${st.liked} liked)`;
              break;
            }
            await sleep(rand(2000, 4000));
            continue;
          }
          st.emptyRounds = 0;
        }

        // --- Process the post ---
        const result = await processPost(logEl, stEl);
        updateUI();
        recordSafe();

        // --- Move to next post ---
        if (!stopped && running) {
          // Try the next arrow first
          const moved = goNextPost();
          if (moved) {
            if (logEl) logEl.textContent = `➡️ Next post...`;
            await sleep(rand(2000, 3500));
          } else {
            // Close and scroll
            if (logEl) logEl.textContent = `➡️ Closing post, scrolling...`;
            closePost();
            await sleep(rand(1500, 2500));
            await humanScroll(rand(500, 1200));
            await sleep(rand(1500, 3000));

            // Update stats display
            const avg = st.postsEngaged > 0 ? Math.round(st.commentsLiked / st.postsEngaged) : 0;
            const nl = safeLimits();
            if (logEl) {
              logEl.textContent = `📊 ${st.liked} liked · ${st.hourlyCount}/${nl.hourly}/hr · ~${avg} comments/post`;
            }
          }
          await burstCheck();
        }
      }
    }

    running = false;
    const finalCount = mode === 'unfollow' ? st.unfollowed : st.liked;
    const action     = mode === 'unfollow' ? 'unfollowed' : 'liked';
    if (logEl && !logEl.textContent.includes('Done') && !logEl.textContent.includes('No more')) {
      logEl.textContent = `■ Stopped (${finalCount} ${action})`;
    }
    if (stEl) { stEl.textContent = `■`; stEl.style.background = ''; }

    saveProfile();
    profile.sessions++;
    saveProfile();
    log(`Engine stopped. Profile saved. Total sessions: ${profile.sessions}`);
  }

  // ========================================================================
  //  UI — Clean inline panel (no popup, left side)
  // ========================================================================

  function updateUI() {
    const el = id => document.getElementById(id);
    const count = mode === 'unfollow' ? st.unfollowed : st.liked;
    const max   = mode === 'unfollow' ? cfg.unfollow.maxUnfollows : cfg.like.maxLikes;
    const safe  = safeLimits();

    if (el('itk-count'))    el('itk-count').textContent = count;
    if (el('itk-progress')) el('itk-progress').textContent = `${count} / ${max}`;
    if (el('itk-bar'))      el('itk-bar').style.width = `${(count / Math.max(1, max)) * 100}%`;
    if (el('itk-hourly'))   el('itk-hourly').textContent =
      `${st.hourlyCount} / ${mode === 'unfollow' ? cfg.unfollow.hourlyLimit : safe.hourly}`;

    if (mode === 'like') {
      const avg = st.postsEngaged > 0 ? Math.round(st.commentsLiked / st.postsEngaged) : 0;
      if (el('itk-perpost')) el('itk-perpost').textContent = `${avg} avg`;
      if (el('itk-engaged')) el('itk-engaged').textContent = st.postsEngaged;
    }
  }

  function createPanel() {
    const old = document.getElementById('itk-panel');
    if (old) old.remove();

    try {
      const saved = sessionStorage.getItem('itk_state');
      if (saved) {
        const s = JSON.parse(saved);
        Object.assign(st, s);
      }
    } catch(_) {}

    const avg  = st.postsEngaged > 0 ? Math.round(st.commentsLiked / st.postsEngaged) : 0;
    const safe = safeLimits();
    const learned = profile.blocks >= 2;
    const personality = ['casual', 'focused', 'browsing', 'scrolling', 'engaged'][FP % 5];

    const panel = document.createElement('div');
    panel.id = 'itk-panel';
    panel.innerHTML = `
<div style="
  position:fixed; left:16px; top:80px; z-index:999999;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  width:340px;
  border-radius:10px;
  box-shadow:0 6px 24px rgba(0,0,0,0.35);
  background:#0d0d18;
  color:#ddd;
  padding:12px 14px;
  user-select:none;
  border:1px solid rgba(255,0,80,0.18);
  font-size:13px;
  line-height:1.4;
">

  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;cursor:move;" id="itk-drag">
    <div style="display:flex;align-items:center;gap:6px;">
      <span style="font-size:15px;">⏹</span>
      <strong style="font-size:15px;color:#ff0050;">Instatakker</strong>
    </div>
    <span style="font-size:9px;opacity:0.35;background:#1a1a2e;padding:1px 5px;border-radius:3px;">v${VERSION}</span>
  </div>

  <!-- Session personality -->
  <div style="font-size:9px;color:#888;margin-bottom:6px;">
    🧬 ${personality} · ${profile.sessions} sessions
    ${learned ? `· max ${profile.maxSafeHourly}/hr safe` : '· building profile'}
  </div>

  <!-- Mode tabs -->
  <div style="display:flex;gap:3px;margin-bottom:8px;background:#1a1a2e;border-radius:6px;padding:2px;">
    <button id="itk-mode-u" style="flex:1;padding:5px 8px;border:none;border-radius:5px;font-weight:600;font-size:11px;cursor:pointer;background:#ff0050;color:#fff;">Unfollow</button>
    <button id="itk-mode-l" style="flex:1;padding:5px 8px;border:none;border-radius:5px;font-weight:600;font-size:11px;cursor:pointer;background:transparent;color:#888;">Like</button>
  </div>

  <!-- Status -->
  <div id="itk-status" style="font-size:11px;padding:5px 8px;background:#1a1a2e;border-radius:5px;margin-bottom:7px;text-align:center;border:1px solid transparent;">
    Press <kbd style="background:#333;padding:1px 5px;border-radius:3px;border:1px solid #555;font-size:10px;">Enter</kbd> to start
  </div>

  <!-- Stats grid -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px;">
    <div style="background:#1a1a2e;border-radius:5px;padding:5px 7px;">
      <div style="font-size:9px;opacity:0.45;">Count</div>
      <div style="font-weight:700;font-size:15px;" id="itk-count">${mode === 'unfollow' ? st.unfollowed : st.liked}</div>
    </div>
    <div style="background:#1a1a2e;border-radius:5px;padding:5px 7px;">
      <div style="font-size:9px;opacity:0.45;">Progress</div>
      <div style="font-weight:600;font-size:12px;" id="itk-progress">${mode === 'unfollow' ? st.unfollowed : st.liked} / ${mode === 'unfollow' ? cfg.unfollow.maxUnfollows : cfg.like.maxLikes}</div>
    </div>
    <div style="background:#1a1a2e;border-radius:5px;padding:5px 7px;">
      <div style="font-size:9px;opacity:0.45;">Hourly</div>
      <div style="font-weight:600;font-size:12px;" id="itk-hourly">${st.hourlyCount} / ${mode === 'unfollow' ? cfg.unfollow.hourlyLimit : safe.hourly}</div>
    </div>
    <div style="background:#1a1a2e;border-radius:5px;padding:5px 7px;display:${mode === 'like' ? 'block' : 'none'};" id="itk-perpost-box">
      <div style="font-size:9px;opacity:0.45;">Comments/Post</div>
      <div style="font-weight:600;font-size:12px;" id="itk-perpost">${avg}</div>
    </div>
  </div>

  <!-- Bar -->
  <div id="itk-bar-wrap" style="width:100%;height:3px;background:#1a1a2e;border-radius:2px;margin:7px 0;overflow:hidden;">
    <div id="itk-bar" style="height:100%;background:linear-gradient(90deg,#ff0050,#ff6b9d);border-radius:2px;width:${((mode === 'unfollow' ? st.unfollowed : st.liked) / Math.max(1, mode === 'unfollow' ? cfg.unfollow.maxUnfollows : cfg.like.maxLikes)) * 100}%;"></div>
  </div>

  <!-- Like-only row -->
  <div id="itk-engaged-row" style="display:${mode === 'like' ? 'flex' : 'none'};justify-content:space-between;font-size:10px;opacity:0.55;margin-bottom:6px;">
    <span>Posts: <span id="itk-engaged">${st.postsEngaged}</span></span>
    <span>Comments: ${st.commentsLiked}</span>
  </div>

  <!-- Log -->
  <div id="itk-log" style="font-size:10px;padding:5px 7px;border-radius:4px;background:#1a1a2e;min-height:16px;word-break:break-word;color:#999;line-height:1.3;">
    Ready · ${personality}
  </div>

  <!-- Settings (collapsible) -->
  <details style="margin-top:6px;">
    <summary style="cursor:pointer;font-size:10px;opacity:0.4;padding:2px 0;">⚙️</summary>
    <div id="itk-s-u" style="margin-top:4px;">
      <div style="font-size:9px;font-weight:600;color:#ff6b9d;margin-bottom:3px;">Unfollow</div>
      <input type="number" id="itk-cfg-max" value="${cfg.unfollow.maxUnfollows}" style="width:100%;padding:2px 5px;border:1px solid rgba(255,255,255,0.06);border-radius:3px;background:#1a1a2e;color:#ddd;font-size:10px;margin:1px 0;">
      <input type="number" id="itk-cfg-hourly" value="${cfg.unfollow.hourlyLimit}" style="width:100%;padding:2px 5px;border:1px solid rgba(255,255,255,0.06);border-radius:3px;background:#1a1a2e;color:#ddd;font-size:10px;margin:1px 0;">
    </div>
    <div id="itk-s-l" style="margin-top:4px;display:none;">
      <div style="font-size:9px;font-weight:600;color:#ff6b9d;margin-bottom:3px;">Like</div>
      <input type="number" id="itk-cfg-like-max" value="${cfg.like.maxLikes}" style="width:100%;padding:2px 5px;border:1px solid rgba(255,255,255,0.06);border-radius:3px;background:#1a1a2e;color:#ddd;font-size:10px;margin:1px 0;">
      <input type="number" id="itk-cfg-like-comments" value="${cfg.like.maxCommentsPerPost}" style="width:100%;padding:2px 5px;border:1px solid rgba(255,255,255,0.06);border-radius:3px;background:#1a1a2e;color:#ddd;font-size:10px;margin:1px 0;">
    </div>
    <div style="font-size:8px;opacity:0.25;margin-top:4px;text-align:center;">
      ${profile.blocks} blocks · ${profile.sessions} sessions · fingerprint: ${(FP % 10000).toString(16)}
    </div>
  </details>
</div>`;

    document.body.appendChild(panel);

    // ---------- Draggable ----------
    const drag = panel.querySelector('#itk-drag');
    const wrapper = panel.firstElementChild;
    let dragging = false, ox, oy;
    drag.addEventListener('mousedown', e => {
      dragging = true;
      ox = e.clientX - wrapper.getBoundingClientRect().left;
      oy = e.clientY - wrapper.getBoundingClientRect().top;
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const x = clamp(e.clientX - ox, 0, window.innerWidth - 350);
      const y = clamp(e.clientY - oy, 0, window.innerHeight - 400);
      wrapper.style.left = x + 'px';
      wrapper.style.top = y + 'px';
      wrapper.style.position = 'fixed';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    // ---------- Mode Tabs ----------
    const uTab = panel.querySelector('#itk-mode-u');
    const lTab = panel.querySelector('#itk-mode-l');
    const sU   = panel.querySelector('#itk-s-u');
    const sL   = panel.querySelector('#itk-s-l');
    const eRow = panel.querySelector('#itk-engaged-row');
    const ppBox = panel.querySelector('#itk-perpost-box');

    function switchMode(m) {
      if (running) return;
      mode = m;
      uTab.style.background = m === 'unfollow' ? '#ff0050' : 'transparent';
      uTab.style.color     = m === 'unfollow' ? '#fff' : '#888';
      lTab.style.background = m === 'like' ? '#ff0050' : 'transparent';
      lTab.style.color     = m === 'like' ? '#fff' : '#888';
      sU.style.display     = m === 'unfollow' ? 'block' : 'none';
      sL.style.display     = m === 'like' ? 'block' : 'none';
      if (eRow) eRow.style.display = m === 'like' ? 'flex' : 'none';
      if (ppBox) ppBox.style.display = m === 'like' ? 'block' : 'none';
      updateUI();
    }

    uTab.addEventListener('click', () => switchMode('unfollow'));
    lTab.addEventListener('click', () => switchMode('like'));
  }

  // ========================================================================
  //  ENTER KEY HANDLER
  // ========================================================================

  document.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || e.repeat) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();

    if (running) {
      stopped = true;
      running = false;
      const c = mode === 'unfollow' ? st.unfollowed : st.liked;
      const a = mode === 'unfollow' ? 'unfollowed' : 'liked';
      const logEl = document.getElementById('itk-log');
      const stEl  = document.getElementById('itk-status');
      if (logEl) logEl.textContent = `■ Stopped (${c} ${a})`;
      if (stEl) { stEl.textContent = `■ Stopped`; stEl.style.background = ''; }
      log('Stopped by user');
      return;
    }

    // Read settings
    if (mode === 'unfollow') {
      const m = document.getElementById('itk-cfg-max');
      const h = document.getElementById('itk-cfg-hourly');
      if (m) cfg.unfollow.maxUnfollows = parseInt(m.value) || DEFAULTS.unfollow.maxUnfollows;
      if (h) cfg.unfollow.hourlyLimit  = parseInt(h.value) || DEFAULTS.unfollow.hourlyLimit;
    } else {
      const m = document.getElementById('itk-cfg-like-max');
      const c = document.getElementById('itk-cfg-like-comments');
      if (m) cfg.like.maxLikes = parseInt(m.value) || DEFAULTS.like.maxLikes;
      if (c) cfg.like.maxCommentsPerPost = parseInt(c.value) || DEFAULTS.like.maxCommentsPerPost;
    }

    stopped = false;
    running = true;
    st.emptyRounds = 0;
    st.consecutiveErrors = 0;

    const logEl = document.getElementById('itk-log');
    const stEl  = document.getElementById('itk-status');
    if (logEl) logEl.textContent = `▶ ${mode}...`;
    if (stEl) {
      stEl.textContent = `▶ Running`;
      stEl.style.background = 'rgba(255,0,80,0.08)';
      stEl.style.border = '1px solid rgba(255,0,80,0.25)';
    }
    log(`Engine starting — ${mode} mode (session ${profile.sessions})`);

    await engine();
    running = false;
  });

  // ========================================================================
  //  INIT
  // ========================================================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel);
  } else {
    createPanel();
  }

  console.log(`%c⏹ Instatakker v${VERSION} — press Enter to start`,
    'color:#ff0050;font-size:14px;font-weight:bold;');
  console.log(`%c  Session fingerprint: ${FP} | ${profile.sessions} sessions`,
    'color:#888;font-size:11px;');
})();
