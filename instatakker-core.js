// ==UserScript==
// @name         Instatakker
// @namespace    http://instatakker.io
// @version      1.1.0
// @description  Instagram automation — unfollow + like everything (posts + comments) like a human
// @author       Instatakker
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  const VERSION = '1.1.0';

  // ======================== CONFIG ========================

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

  let config = {
    unfollow: { ...DEFAULTS.unfollow },
    like: { ...DEFAULTS.like },
  };

  let running = false;
  let stopped = false;
  let mode = 'unfollow';

  let state = {
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

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const randDelay = (min, max) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

  function log(msg) {
    console.log(`[Instatakker] ${msg}`);
  }

  // ======================== HUMAN-LIKE BEHAVIOR ========================

  /**
   * Generate a human-like delay pattern.
   * Humans don't click at perfectly random intervals.
   * They have bursts of activity followed by pauses.
   */
  function humanDelay(baseMin, baseMax) {
    // Occasionally take a longer "break" like a human would
    const pauseChance = Math.random();
    if (pauseChance < 0.08) {
      // 8% chance of a "let me read this" pause
      return randDelay(5000, 12000);
    }
    if (pauseChance < 0.12) {
      // 4% chance of a "distracted" pause
      return randDelay(10000, 25000);
    }

    // Normal human rhythm — slightly clustered
    const delay = randDelay(baseMin, baseMax);
    // Add small variance
    return Math.round(delay * (0.9 + Math.random() * 0.2));
  }

  /**
   * Human-like scrolling: small increments with pauses.
   */
  async function humanScroll(distance) {
    const steps = Math.ceil(distance / 200);
    for (let i = 0; i < Math.min(steps, 8); i++) {
      if (stopped || !running) break;
      window.scrollBy(0, randDelay(150, 350));
      await sleep(randDelay(200, 600));
    }
  }

  /**
   * Human-like mouse movement simulation on an element.
   * We can't actually move the mouse in userscript, but we can add delays
   * that simulate "finding" the button and moving to it.
   */
  async function humanHoverDelay() {
    // Simulate the time it takes to move mouse to a target
    await sleep(randDelay(200, 800));
  }

  // ======================== LIMIT TRACKING (persistent learning) ========================

  function getAccountKey() {
    try {
      const meta = document.querySelector('meta[property="og:url"]');
      if (meta) {
        const url = meta.getAttribute('content');
        const match = url.match(/instagram\.com\/([^\/]+)/);
        if (match) return `instatakker_limits_${match[1]}`;
      }
      // Also try from the page path
      const path = window.location.pathname.split('/')[1];
      if (path && path.length > 0 && path.length < 50) {
        return `instatakker_limits_${path}`;
      }
    } catch(e) {}
    return 'instatakker_limits_default';
  }

  const LIMITS_KEY = getAccountKey();

  function loadLimits() {
    try {
      const raw = localStorage.getItem(LIMITS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        log(`📂 Loaded learned limits for this account`);
        return parsed;
      }
    } catch(e) {}
    return {
      blockHistory: [],
      learnedHourlyCap: 200,
      learnedPerPostCap: 150,
      totalSessions: 0,
      lastUpdated: null,
      // Keep track of "safe" levels we've operated at
      maxSafeHourly: 0,
      maxSafePerPost: 0,
    };
  }

  function saveLimits(limits) {
    try {
      limits.lastUpdated = Date.now();
      localStorage.setItem(LIMITS_KEY, JSON.stringify(limits));
    } catch(e) {}
  }

  let limits = loadLimits();
  limits.totalSessions++;

  /**
   * Record when we hit a rate limit / action block.
   * We learn the ceiling and stay below it next time.
   */
  function recordBlock(action) {
    limits.blockHistory.push({
      action: action,
      hourlyCount: state.hourlyCount,
      totalActions: state.liked,
      timestamp: Date.now(),
    });

    // Keep last 20 blocks
    if (limits.blockHistory.length > 20) {
      limits.blockHistory = limits.blockHistory.slice(-20);
    }

    // Calculate learned limits based on block history
    const recentBlocks = limits.blockHistory.slice(-5);
    if (recentBlocks.length >= 2) {
      const avgHourly = Math.round(
        recentBlocks.reduce((s, b) => s + b.hourlyCount, 0) / recentBlocks.length
      );

      // Set learned cap at 70% of average block point (safe margin)
      limits.learnedHourlyCap = Math.max(40, Math.round(avgHourly * 0.7));
      limits.learnedPerPostCap = Math.max(20, Math.round(limits.learnedHourlyCap / 3.5));

      log(`🧠 Blocked at ${state.hourlyCount}/hr. New safe limits: ${limits.learnedHourlyCap}/hr, ${limits.learnedPerPostCap}/post`);
    }

    saveLimits(limits);
  }

  /**
   * Track that we successfully operated at a certain level without getting blocked.
   * This helps us know our actual safe zone.
   */
  function recordSafeOperation() {
    if (state.hourlyCount > limits.maxSafeHourly) {
      limits.maxSafeHourly = state.hourlyCount;
      limits.maxSafePerPost = Math.max(limits.maxSafePerPost,
        Math.round(state.commentsLiked / Math.max(1, state.postsEngaged)));
      saveLimits(limits);
    }
  }

  function getSafeLimits() {
    if (limits.blockHistory.length >= 2) {
      return {
        hourlyCap: Math.min(config.like.hourlyLimit, Math.max(limits.maxSafeHourly + 10, limits.learnedHourlyCap)),
        perPostCap: Math.min(config.like.maxCommentsPerPost, Math.max(limits.maxSafePerPost + 5, limits.learnedPerPostCap)),
      };
    }
    // No blocks yet — use configured limits but cap at a conservative level for new accounts
    return {
      hourlyCap: Math.min(config.like.hourlyLimit, 100),
      perPostCap: Math.min(config.like.maxCommentsPerPost, 50),
    };
  }

  // ======================== UNFOLLOW MODE ========================

  function getFollowingButtons() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return [];
    return [...dialog.querySelectorAll('button')].filter(b => {
      if (!b.offsetParent) return false;
      return (b.innerText || '').trim() === 'Following';
    });
  }

  function clickUnfollowConfirm() {
    const btn = [...document.querySelectorAll('button')].find(b => {
      if (!b.offsetParent) return false;
      return (b.innerText || '').trim() === 'Unfollow';
    });
    if (btn) { btn.click(); return true; }
    return false;
  }

  function scrollFollowingList() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return false;
    const scrollables = [...dialog.querySelectorAll('div')].filter(d => {
      try { return d.scrollHeight > d.clientHeight + 30; } catch(e) { return false; }
    });
    if (scrollables.length > 0) {
      scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight)[0].scrollTop += 800;
      return true;
    }
    return false;
  }

  // ======================== LIKE MODE (Post + Comments) ========================

  function likeCurrentPost() {
    const likeSvg = document.querySelector('svg[aria-label="Like"]');
    if (!likeSvg) return false;
    const clickable = likeSvg.closest('button') || likeSvg.closest('span[role="button"]') || likeSvg.closest('div[role="button"]') || likeSvg.parentElement;
    if (!clickable) return false;
    clickable.click();
    return true;
  }

  function clickLoadMoreComments() {
    const loadMoreSvg = document.querySelector('svg[aria-label="Load more comments"]');
    if (!loadMoreSvg) return false;

    const clickable = loadMoreSvg.closest('button') ||
                      loadMoreSvg.closest('div[role="button"]') ||
                      loadMoreSvg.closest('span') ||
                      loadMoreSvg.parentElement;
    if (!clickable) return false;

    clickable.click();
    return true;
  }

  function getUnlikeCommentButtons() {
    const allCommentLikeSvgs = [...document.querySelectorAll('ul ul svg[aria-label="Like"]')];
    const seen = new Set();
    return allCommentLikeSvgs.filter(svg => {
      const li = svg.closest('li');
      if (!li || seen.has(li)) return false;
      seen.add(li);
      return true;
    });
  }

  function likeComment(svg) {
    const clickable = svg.closest('button') || svg.closest('span[role="button"]') || svg.parentElement;
    if (!clickable) return false;
    clickable.click();
    return true;
  }

  function scrollCommentSection() {
    const commentAreas = [...document.querySelectorAll('ul')].filter(ul => {
      try { return ul.scrollHeight > ul.clientHeight + 20; } catch(e) { return false; }
    });
    if (commentAreas.length > 0) {
      commentAreas[0].scrollTop = commentAreas[0].scrollHeight;
      return true;
    }

    const dialog = document.querySelector('div[role="dialog"]');
    if (dialog) {
      const scrollables = [...dialog.querySelectorAll('div')].filter(d => {
        try { return d.scrollHeight > d.clientHeight + 30; } catch(e) { return false; }
      });
      if (scrollables.length > 0) {
        scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight)[0].scrollTop += 500;
        return true;
      }
    }
    return false;
  }

  function isInPostView() {
    return !!document.querySelector('div[role="dialog"] article');
  }

  /**
   * Like EVERYTHING — all comments on the post.
   * Keeps clicking "Load more comments" until no more load.
   * Keeps scrolling until no more comments appear.
   */
  async function likeAllComments(logArea, statusEl) {
    let commentsLiked = 0;
    let roundsWithoutNewComments = 0;
    let previousCommentCount = 0;
    const maxRounds = 100; // safety cap
    const safeLimits = getSafeLimits();

    for (let round = 0; round < maxRounds; round++) {
      if (stopped || !running) break;

      // Check hourly limit
      if (state.hourlyCount >= safeLimits.hourlyCap) {
        if (statusEl) {
          statusEl.textContent = `⏳ Hit hourly cap (${state.hourlyCount})`;
          statusEl.style.background = '#ff6b9d22';
        }
        recordBlock('hourly_cap');
        break;
      }

      // Step 1: Click "Load more comments" if visible
      const loadClicked = clickLoadMoreComments();
      if (loadClicked) {
        await sleep(randDelay(1500, 3000));
        if (logArea) logArea.textContent = `📄 Loading more comments... (${commentsLiked} liked so far)`;
      }

      // Step 2: Scroll comments section
      scrollCommentSection();
      await sleep(randDelay(1000, 2000));

      // Step 3: Find and like ALL unliked comments
      const commentSvgs = getUnlikeCommentButtons();

      if (commentSvgs.length > 0) {
        roundsWithoutNewComments = 0;

        for (const svg of commentSvgs) {
          if (stopped || !running) break;
          if (!document.contains(svg)) continue;

          // Check hourly
          if (state.hourlyCount >= safeLimits.hourlyCap) {
            recordBlock('hourly_cap_mid_comment');
            break;
          }

          // Human-like hover before clicking
          await humanHoverDelay();

          const success = likeComment(svg);
          if (success) {
            commentsLiked++;
            state.liked++;
            state.hourlyCount++;
            state.commentsLiked++;

            if (logArea) {
              logArea.textContent = `💬 Liked ${commentsLiked} comments (total: ${state.liked})`;
            }
            if (statusEl) {
              statusEl.textContent = `❤️${state.liked} | 💬${commentsLiked}`;
            }

            // Human-like delay between comment likes
            // Sometimes faster, sometimes slower — like a real person
            await sleep(humanDelay(
              config.like.minCommentDelay,
              config.like.maxCommentDelay
            ));
          } else {
            state.consecutiveErrors++;
            if (state.consecutiveErrors > 5) {
              log('Too many errors — cooling down');
              await sleep(10000);
              state.consecutiveErrors = 0;
            }
            await sleep(500);
          }
        }
      } else {
        // No comments to like right now
        roundsWithoutNewComments++;

        // Check if new comments loaded
        if (roundsWithoutNewComments >= 3 && !loadClicked) {
          // No new comments and no load button — we're done
          log(`✅ Liked all ${commentsLiked} comments on this post`);
          break;
        }

        // Wait for more comments to potentially load
        await sleep(randDelay(2000, 4000));
      }

      // Track progress
      if (round % 5 === 0) {
        recordSafeOperation();
      }
    }

    state.postsEngaged++;
    return commentsLiked;
  }

  // ======================== MAIN ENGINE ========================

  async function instatakkerEngine() {
    state.startTime = state.startTime || Date.now();
    const logArea = document.getElementById('itk-log');
    const statusEl = document.getElementById('itk-status');
    const safeLimits = getSafeLimits();

    // Show learned limits at start
    if (limits.blockHistory.length >= 2) {
      if (logArea) {
        logArea.textContent = `🧠 Learned: ~${safeLimits.hourlyCap}/hr | Max safe: ${limits.maxSafeHourly}/hr`;
      }
    } else {
      if (logArea) {
        logArea.textContent = `🆕 New account — starting conservative (${safeLimits.hourlyCap}/hr)`;
      }
    }

    while (running && !stopped) {
      // Hourly limit reset
      if (Date.now() - state.hourlyReset > 3600000) {
        state.hourlyCount = 0;
        state.hourlyReset = Date.now();
        log('⏰ Hourly counter reset');
      }

      if (state.hourlyCount >= safeLimits.hourlyCap) {
        const waitMs = 3600000 - (Date.now() - state.hourlyReset);
        const waitMin = Math.ceil(waitMs / 60000);
        if (logArea) logArea.textContent = `⏳ Hit cap (${state.hourlyCount}) — waiting ${waitMin}min`;
        if (statusEl) {
          statusEl.textContent = `⏳ Waiting ${waitMin}min`;
          statusEl.style.background = '#ff6b9d22';
        }
        recordBlock('hourly_cap_reached');

        // Instead of waiting the full hour, do a human-like "come back later" pause
        await sleep(randDelay(300000, 600000)); // 5-10 min
        // Then check if we're still over the hourly limit
        if (state.hourlyCount >= safeLimits.hourlyCap) {
          await sleep(Math.min(waitMs + 5000, 3600000));
        }

        state.hourlyCount = 0;
        state.hourlyReset = Date.now();

        if (statusEl) {
          statusEl.style.background = '';
          statusEl.style.border = '';
        }
        continue;
      }

      const currentCount = mode === 'unfollow' ? state.unfollowed : state.liked;
      const maxLimit = mode === 'unfollow' ? config.unfollow.maxUnfollows : config.like.maxLikes;

      if (currentCount >= maxLimit) {
        if (logArea) logArea.textContent = `✅ ${mode === 'unfollow' ? 'Unfollowed' : 'Liked'} ${currentCount}`;
        break;
      }

      if (mode === 'unfollow') {
        // ===================== UNFOLLOW =====================
        if (!document.querySelector('div[role="dialog"]')) {
          if (logArea) logArea.textContent = '⚠️ Open Following list';
          await sleep(2000);
          continue;
        }

        const buttons = getFollowingButtons();
        log(`Found ${buttons.length} Following buttons`);

        if (buttons.length === 0) {
          state.emptyRounds++;
          if (state.emptyRounds >= config.unfollow.emptyRoundsBeforeStop) {
            if (logArea) logArea.textContent = `🏁 Done (${state.unfollowed} unfollowed)`;
            break;
          }
          if (logArea) logArea.textContent = `⚠️ No Following buttons (${state.emptyRounds}/${config.unfollow.emptyRoundsBeforeStop})`;
        } else {
          state.emptyRounds = 0;
          state.consecutiveErrors = 0;
          const btn = buttons[0];
          if (!document.contains(btn)) continue;
          if ((btn.innerText || '').trim() !== 'Following') continue;

          log(`Unfollowing #${state.unfollowed + 1}`);
          if (logArea) logArea.textContent = `▶ Unfollowing #${state.unfollowed + 1}...`;

          try { btn.scrollIntoView({ block: 'center' }); } catch(e) {}
          await humanHoverDelay();
          btn.click();
          await sleep(randDelay(1200, 2500));

          const confirmed = clickUnfollowConfirm();
          if (confirmed) {
            state.unfollowed++;
            state.hourlyCount++;
            updateUI();
            if (statusEl) statusEl.textContent = `✅${state.unfollowed}`;
            await sleep(humanDelay(config.unfollow.minDelay, config.unfollow.maxDelay));
          } else {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await sleep(1500);
            const stillThere = getFollowingButtons().some(b =>
              document.contains(b) && b.innerText.trim() === 'Following' && b === btn
            );
            if (!stillThere) {
              state.unfollowed++;
              state.hourlyCount++;
              updateUI();
              if (statusEl) statusEl.textContent = `✅${state.unfollowed}`;
              await sleep(humanDelay(config.unfollow.minDelay, config.unfollow.maxDelay));
            } else {
              if (logArea) logArea.textContent = '⚠️ Cooling 30s...';
              if (statusEl) {
                statusEl.textContent = `⚠️`;
                statusEl.style.background = '#ff6b9d22';
              }
              await sleep(30000);
              if (statusEl) statusEl.style.background = '';
            }
          }
        }
        scrollFollowingList();
        await sleep(config.unfollow.scrollWait);

      } else {
        // ===================== LIKE MODE =====================

        // Rate limit check
        const safe = getSafeLimits();
        if (state.hourlyCount >= safe.hourlyCap * 0.9) {
          // Getting close to limit — be more conservative
          if (logArea) logArea.textContent = `⚠️ Approaching limit (${state.hourlyCount}/${safe.hourlyCap})`;
          if (Math.random() < 0.3) {
            // 30% chance to take a break
            await sleep(randDelay(10000, 30000));
          }
        }

        // Open a post if not already in one
        if (!isInPostView()) {
          const postLinks = [
            document.querySelector('article a[href*="/p/"]'),
            document.querySelector('article[role="presentation"] a'),
          ].filter(Boolean);

          if (postLinks.length > 0) {
            // Randomly pick which post to open (not always the first)
            const postLink = postLinks[Math.floor(Math.random() * postLinks.length)];
            postLink.click();
            await sleep(randDelay(2000, 3500));
            if (logArea) logArea.textContent = `📱 Opened post (${state.liked} liked)`;
          } else {
            if (logArea) logArea.textContent = '⚠️ No posts found. Navigate to a hashtag or feed.';
            await sleep(3000);
            continue;
          }
        }

        if (!isInPostView()) {
          if (logArea) logArea.textContent = '⚠️ Click a post, then press Enter';
          await sleep(2000);
          continue;
        }

        // --- Step 1: Like the post ---
        await humanHoverDelay();
        const likedPost = likeCurrentPost();
        if (likedPost) {
          state.liked++;
          state.hourlyCount++;
          state.postsEngaged++;
          if (logArea) logArea.textContent = `❤️ Liked post ${state.postsEngaged}`;
          if (statusEl) statusEl.textContent = `❤️${state.liked}`;
          log(`Liked post #${state.postsEngaged}`);

          // Human pause after liking — "look" at the post
          await sleep(humanDelay(3000, 8000));
        } else {
          if (logArea) logArea.textContent = `📌 Already liked (${state.liked} total)`;
        }

        // --- Step 2: Like ALL comments ---
        if (logArea) logArea.textContent = `💬 Liking all comments...`;
        const commentCount = await likeAllComments(logArea, statusEl);

        if (commentCount > 0) {
          log(`✅ Post ${state.postsEngaged}: liked all ${commentCount} comments`);
          updateUI();
        }

        // --- Step 3: Close post and move to next ---
        if (!stopped && running) {
          if (logArea) logArea.textContent = `➡️ Moving to next post...`;
          log('Closing post');

          const closeSvg = document.querySelector('svg[aria-label="Close"]');
          if (closeSvg) {
            const closeBtn = closeSvg.closest('button') || closeSvg.parentElement;
            if (closeBtn) closeBtn.click();
          } else {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          }
          await sleep(randDelay(1500, 2500));

          // Human scroll
          await humanScroll(900);
          await sleep(randDelay(1500, 3000));

          // Update stats
          recordSafeOperation();
          const newsafe = getSafeLimits();
          const avgComments = state.postsEngaged > 0
            ? Math.round(state.commentsLiked / state.postsEngaged)
            : 0;
          if (logArea) {
            logArea.textContent = `📊 ${state.liked} liked | ${state.hourlyCount}/${newsafe.hourlyCap}/hr | ~${avgComments} comments/post`;
          }
        }
      }
    }

    running = false;
    if (logArea) {
      if (!logArea.textContent.includes('Done') && !logArea.textContent.includes('No more')) {
        const count = mode === 'unfollow' ? state.unfollowed : state.liked;
        const action = mode === 'unfollow' ? 'unfollowed' : 'liked';
        logArea.textContent = `■ Stopped (${count} ${action})`;
      }
    }
    if (statusEl) {
      statusEl.textContent = `■`;
      statusEl.style.background = '';
      statusEl.style.border = '';
    }

    saveLimits(limits);
    log(`Engine stopped. Learning data saved. Total sessions: ${limits.totalSessions}`);
  }

  // ======================== UI ========================

  function updateUI() {
    const countEl = document.getElementById('itk-count');
    const progressEl = document.getElementById('itk-progress');
    const barEl = document.getElementById('itk-bar');
    const hourlyEl = document.getElementById('itk-hourly');
    const perPostEl = document.getElementById('itk-perpost');
    const engagedEl = document.getElementById('itk-engaged');

    const currentCount = mode === 'unfollow' ? state.unfollowed : state.liked;
    const maxCount = mode === 'unfollow' ? config.unfollow.maxUnfollows : config.like.maxLikes;

    if (countEl) countEl.textContent = currentCount;
    if (progressEl) progressEl.textContent = `${currentCount} / ${maxCount}`;
    if (barEl) barEl.style.width = `${(currentCount / maxCount) * 100}%`;
    if (hourlyEl) hourlyEl.textContent = `${state.hourlyCount} / ${mode === 'unfollow' ? config.unfollow.hourlyLimit : getSafeLimits().hourlyCap}`;

    if (mode === 'like') {
      if (perPostEl) {
        const avg = state.postsEngaged > 0 ? Math.round(state.commentsLiked / state.postsEngaged) : 0;
        perPostEl.textContent = `${avg} avg`;
      }
      if (engagedEl) engagedEl.textContent = state.postsEngaged;
    }
  }

  function createPanel() {
    const existing = document.getElementById('instatakker-panel');
    if (existing) existing.remove();

    try {
      const saved = sessionStorage.getItem('instatakker_state');
      if (saved) state = { ...state, ...JSON.parse(saved) };
    } catch(e) {}

    const avgComments = state.postsEngaged > 0 ? Math.round(state.commentsLiked / state.postsEngaged) : 0;
    const safe = getSafeLimits();
    const hasLearned = limits.blockHistory.length >= 2;

    const panel = document.createElement('div');
    panel.id = 'instatakker-panel';
    panel.innerHTML = `
      <div style="position:fixed;top:20px;right:20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;width:370px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);background:#0f0f1a;color:#e0e0e0;padding:16px;user-select:none;border:1px solid rgba(255,0,80,0.25);">

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;cursor:move;" id="itk-drag">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:16px;">⏹</span>
            <h2 style="margin:0;font-size:17px;font-weight:700;color:#ff0050;letter-spacing:-0.3px;">Instatakker</h2>
          </div>
          <span style="font-size:10px;opacity:0.4;background:#1a1a2e;padding:2px 6px;border-radius:4px;">v${VERSION}</span>
        </div>

        <div style="display:flex;gap:4px;margin-bottom:10px;background:#1a1a2e;border-radius:8px;padding:3px;">
          <button id="itk-mode-unfollow" style="flex:1;padding:6px 10px;border:none;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer;background:#ff0050;color:white;transition:all 0.2s;">Unfollow</button>
          <button id="itk-mode-like" style="flex:1;padding:6px 10px;border:none;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer;background:transparent;color:#888;transition:all 0.2s;">Like</button>
        </div>

        ${hasLearned ? `
        <div style="font-size:10px;color:#ff6b9d;background:#ff6b9d10;padding:4px 8px;border-radius:4px;margin-bottom:8px;border:1px solid #ff6b9d25;display:flex;justify-content:space-between;">
          <span>🧠 ${limits.totalSessions} sessions</span>
          <span>max ${limits.maxSafeHourly}/hr safe</span>
        </div>
        ` : `
        <div style="font-size:10px;color:#888;background:#1a1a2e;padding:4px 8px;border-radius:4px;margin-bottom:8px;text-align:center;">
          New account — building activity profile
        </div>
        `}

        <div id="itk-status" style="font-size:12px;padding:6px 10px;background:#1a1a2e;border-radius:6px;margin-bottom:8px;text-align:center;border:1px solid transparent;transition:all 0.2s;">
          Press <kbd style="background:#333;padding:1px 5px;border-radius:3px;border:1px solid #555;font-size:11px;">Enter</kbd> to start
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
          <div style="background:#1a1a2e;border-radius:6px;padding:6px 8px;">
            <div style="font-size:10px;opacity:0.5;">Count</div>
            <div style="font-weight:700;font-size:16px;" id="itk-count">${mode === 'unfollow' ? state.unfollowed : state.liked}</div>
          </div>
          <div style="background:#1a1a2e;border-radius:6px;padding:6px 8px;">
            <div style="font-size:10px;opacity:0.5;">Progress</div>
            <div style="font-weight:600;font-size:13px;" id="itk-progress">${mode === 'unfollow' ? state.unfollowed : state.liked} / ${mode === 'unfollow' ? config.unfollow.maxUnfollows : config.like.maxLikes}</div>
          </div>
          <div style="background:#1a1a2e;border-radius:6px;padding:6px 8px;">
            <div style="font-size:10px;opacity:0.5;">Hourly</div>
            <div style="font-weight:600;font-size:13px;" id="itk-hourly">${state.hourlyCount} / ${mode === 'unfollow' ? config.unfollow.hourlyLimit : safe.hourlyCap}</div>
          </div>
          <div style="background:#1a1a2e;border-radius:6px;padding:6px 8px;display:${mode === 'like' ? 'block' : 'none'};">
            <div style="font-size:10px;opacity:0.5;">Comments/Post</div>
            <div style="font-weight:600;font-size:13px;" id="itk-perpost">${avgComments}</div>
          </div>
        </div>

        <div style="width:100%;height:4px;background:#1a1a2e;border-radius:2px;margin:10px 0;overflow:hidden;">
          <div id="itk-bar" style="height:100%;background:linear-gradient(90deg,#ff0050,#ff6b9d);border-radius:2px;transition:width 0.3s;width:${((mode === 'unfollow' ? state.unfollowed : state.liked) / (mode === 'unfollow' ? config.unfollow.maxUnfollows : config.like.maxLikes)) * 100}%;"></div>
        </div>

        <div id="itk-engaged-row" style="display:${mode === 'like' ? 'flex' : 'none'};justify-content:space-between;font-size:11px;opacity:0.6;margin-bottom:8px;">
          <span>Posts: <span id="itk-engaged">${state.postsEngaged}</span></span>
          <span>Comments: ${state.commentsLiked}</span>
        </div>

        <div id="itk-log" style="font-size:11px;padding:6px 8px;border-radius:4px;background:#1a1a2e;min-height:18px;word-break:break-word;color:#aaa;line-height:1.4;">
          Ready
        </div>

        <div style="font-size:10px;opacity:0.4;margin-top:6px;text-align:center;">
          ${mode === 'unfollow' ? 'Following list → Enter' : '#hashtag or feed → Enter'}
        </div>

        <details style="margin-top:8px;">
          <summary style="cursor:pointer;font-size:11px;opacity:0.5;padding:4px 0;">⚙️ Settings</summary>
          <div id="itk-settings-unfollow" style="margin-top:6px;">
            <div style="font-size:10px;font-weight:600;color:#ff6b9d;margin-bottom:4px;">Unfollow</div>
            <input type="number" id="itk-cfg-max" value="${config.unfollow.maxUnfollows}" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;margin:2px 0;">
            <input type="number" id="itk-cfg-hourly" value="${config.unfollow.hourlyLimit}" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;margin:2px 0;">
          </div>
          <div id="itk-settings-like" style="margin-top:6px;display:none;">
            <div style="font-size:10px;font-weight:600;color:#ff6b9d;margin-bottom:4px;">Like</div>
            <input type="number" id="itk-cfg-like-max" value="${config.like.maxLikes}" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;margin:2px 0;">
            <input type="number" id="itk-cfg-like-comments" value="${config.like.maxCommentsPerPost}" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;margin:2px 0;">
          </div>
          <div style="font-size:9px;opacity:0.3;margin-top:6px;text-align:center;">
            Learning: ${limits.blockHistory.length} blocks | ${limits.totalSessions} sessions
          </div>
        </details>
      </div>
    `;

    document.body.appendChild(panel);

    // Draggable
    const dragHandle = panel.querySelector('#itk-drag');
    let isDragging = false, ox, oy;
    const p = panel.firstElementChild;
    dragHandle.addEventListener('mousedown', (e) => {
      isDragging = true;
      ox = e.clientX - p.getBoundingClientRect().left;
      oy = e.clientY - p.getBoundingClientRect().top;
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      p.style.left = (e.clientX - ox) + 'px';
      p.style.top = (e.clientY - oy) + 'px';
      p.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { isDragging = false; });

    // Tab switching
    const unfollowTab = panel.querySelector('#itk-mode-unfollow');
    const likeTab = panel.querySelector('#itk-mode-like');
    const settingsUnfollow = panel.querySelector('#itk-settings-unfollow');
    const settingsLike = panel.querySelector('#itk-settings-like');
    const engagedRow = panel.querySelector('#itk-engaged-row');

    function switchMode(newMode) {
      if (running) return;
      mode = newMode;

      unfollowTab.style.background = newMode === 'unfollow' ? '#ff0050' : 'transparent';
      unfollowTab.style.color = newMode === 'unfollow' ? 'white' : '#888';
      likeTab.style.background = newMode === 'like' ? '#ff0050' : 'transparent';
      likeTab.style.color = newMode === 'like' ? 'white' : '#888';

      settingsUnfollow.style.display = newMode === 'unfollow' ? 'block' : 'none';
      settingsLike.style.display = newMode === 'like' ? 'block' : 'none';

      if (engagedRow) engagedRow.style.display = newMode === 'like' ? 'flex' : 'none';

      updateUI();
    }

    unfollowTab.addEventListener('click', () => switchMode('unfollow'));
    likeTab.addEventListener('click', () => switchMode('like'));
  }

  // ======================== ENTER KEY ========================

  document.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.repeat) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();

      if (running) {
        stopped = true;
        running = false;
        const logArea = document.getElementById('itk-log');
        const statusEl = document.getElementById('itk-status');
        const count = mode === 'unfollow' ? state.unfollowed : state.liked;
        const action = mode === 'unfollow' ? 'unfollowed' : 'liked';
        if (logArea) logArea.textContent = `■ Stopped (${count} ${action})`;
        if (statusEl) { statusEl.textContent = `■ Stopped`; statusEl.style.background = ''; }
        log('Stopped by user');
        return;
      }

      // Read config
      if (mode === 'unfollow') {
        const maxEl = document.getElementById('itk-cfg-max');
        const hourlyEl = document.getElementById('itk-cfg-hourly');
        if (maxEl) config.unfollow.maxUnfollows = parseInt(maxEl.value) || DEFAULTS.unfollow.maxUnfollows;
        if (hourlyEl) config.unfollow.hourlyLimit = parseInt(hourlyEl.value) || DEFAULTS.unfollow.hourlyLimit;
      } else {
        const maxEl = document.getElementById('itk-cfg-like-max');
        const commentsEl = document.getElementById('itk-cfg-like-comments');
        if (maxEl) config.like.maxLikes = parseInt(maxEl.value) || DEFAULTS.like.maxLikes;
        if (commentsEl) config.like.maxCommentsPerPost = parseInt(commentsEl.value) || DEFAULTS.like.maxCommentsPerPost;
      }

      stopped = false;
      running = true;
      state.emptyRounds = 0;
      state.consecutiveErrors = 0;

      const logArea = document.getElementById('itk-log');
      const statusEl = document.getElementById('itk-status');
      if (logArea) logArea.textContent = `▶ ${mode}...`;
      if (statusEl) {
        statusEl.textContent = `▶ Running`;
        statusEl.style.background = '';
        statusEl.style.border = '';
      }
      log(`Engine started in ${mode} mode`);

      await instatakkerEngine();
      running = false;
    }
  });

  // ======================== INIT ========================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel);
  } else {
    createPanel();
  }

  console.log(`%c⏹ Instatakker v${VERSION} — press Enter`, 'color: #ff0050; font-size: 14px; font-weight: bold;');
})();
