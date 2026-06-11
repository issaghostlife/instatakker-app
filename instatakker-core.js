// ==UserScript==
// @name         Instatakker
// @namespace    http://instatakker.io
// @version      2.0.0
// @description  Instagram automation — unfollow + like everything (posts + comments) like a human
// @author       Instatakker
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  const VERSION = '2.0.0';

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
      maxCommentsPerPost: 100,   // ← FIXED: capped at 100 max per post
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

  function humanDelay(baseMin, baseMax) {
    const pauseChance = Math.random();
    if (pauseChance < 0.08) {
      return randDelay(5000, 12000);
    }
    if (pauseChance < 0.12) {
      return randDelay(10000, 25000);
    }
    const delay = randDelay(baseMin, baseMax);
    return Math.round(delay * (0.9 + Math.random() * 0.2));
  }

  async function humanScroll(distance) {
    const steps = Math.ceil(distance / 200);
    for (let i = 0; i < Math.min(steps, 8); i++) {
      if (stopped || !running) break;
      window.scrollBy(0, randDelay(150, 350));
      await sleep(randDelay(200, 600));
    }
  }

  async function humanHoverDelay() {
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

  function recordBlock(action) {
    limits.blockHistory.push({
      action: action,
      hourlyCount: state.hourlyCount,
      totalActions: state.liked,
      timestamp: Date.now(),
    });

    if (limits.blockHistory.length > 20) {
      limits.blockHistory = limits.blockHistory.slice(-20);
    }

    const recentBlocks = limits.blockHistory.slice(-5);
    if (recentBlocks.length >= 2) {
      const avgHourly = Math.round(
        recentBlocks.reduce((s, b) => s + b.hourlyCount, 0) / recentBlocks.length
      );
      limits.learnedHourlyCap = Math.max(40, Math.round(avgHourly * 0.7));
      limits.learnedPerPostCap = Math.max(20, Math.round(limits.learnedHourlyCap / 3.5));
      log(`🧠 Blocked at ${state.hourlyCount}/hr. New safe limits: ${limits.learnedHourlyCap}/hr, ${limits.learnedPerPostCap}/post`);
    }

    saveLimits(limits);
  }

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

  // ======================== LIKE MODE (Post + Comments) — FIXED ========================

  /**
   * FIXED: Like only the POST (not comments).
   * Uses the selectors from inside the post dialog.
   * Checks for "Like" vs "Unlike" to avoid double-liking.
   */
  function getPostLikeButton() {
    // Strategy 1: Inside a role="dialog" that contains an article (post view)
    const dialog = document.querySelector('div[role="dialog"]');
    if (dialog) {
      // Post like button is the FIRST svg[aria-label="Like"] inside article section
      const article = dialog.querySelector('article');
      if (article) {
        const likeSvg = article.querySelector('section svg[aria-label="Like"], section svg[aria-label="Unlike"]');
        if (likeSvg) return likeSvg;
      }
      // Fallback: first "Like" svg in dialog that's NOT inside a nested list (comment area)
      const allLikeSvgs = [...dialog.querySelectorAll('svg[aria-label="Like"]')];
      for (const svg of allLikeSvgs) {
        // Skip svgs inside comment lists (ul > li structures)
        const inComment = svg.closest('ul ul') || svg.closest('li div[role="button"]');
        if (!inComment) return svg;
      }
    }

    // Strategy 2: No dialog — single post page (instagram.com/p/...)
    const article = document.querySelector('article');
    if (article) {
      const likeSvg = article.querySelector('section svg[aria-label="Like"], section svg[aria-label="Unlike"]');
      if (likeSvg) return likeSvg;
    }

    return null;
  }

  function isPostAlreadyLiked() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (dialog) {
      const article = dialog.querySelector('article');
      if (article) {
        const unlikeSvg = article.querySelector('section svg[aria-label="Unlike"]');
        return !!unlikeSvg;
      }
    }
    return !!document.querySelector('article section svg[aria-label="Unlike"]');
  }

  async function likeCurrentPost() {
    // Don't like if already liked
    if (isPostAlreadyLiked()) {
      log('Post already liked, skipping');
      return true;
    }

    const likeSvg = getPostLikeButton();
    if (!likeSvg) {
      log('Post like button not found');
      return false;
    }

    // Find the clickable parent
    const clickable = likeSvg.closest('button') ||
                      likeSvg.closest('div[role="button"]') ||
                      likeSvg.closest('span[role="button"]') ||
                      likeSvg.parentElement;
    if (!clickable) return false;

    clickable.click();
    await sleep(500);
    return true;
  }

  /**
   * FIXED: Click "Load more comments" button
   * Uses the correct selector for Instagram's current DOM
   */
  function clickLoadMoreComments() {
    // Look for "Load more comments" text button or the SVG
    const dialog = document.querySelector('div[role="dialog"]');

    // Strategy 1: Button with text "Load more comments"
    if (dialog) {
      const loadMoreBtn = [...dialog.querySelectorAll('button')].find(b =>
        b.textContent.trim().toLowerCase().includes('load more comments') ||
        b.textContent.trim().toLowerCase().includes('view all') ||
        b.getAttribute('aria-label') === 'Load more comments'
      );
      if (loadMoreBtn) {
        loadMoreBtn.click();
        return true;
      }
    }

    // Strategy 2: SVG with aria-label="Load more comments"
    const loadMoreSvg = document.querySelector('svg[aria-label="Load more comments"]');
    if (loadMoreSvg) {
      const clickable = loadMoreSvg.closest('button') ||
                        loadMoreSvg.closest('div[role="button"]') ||
                        loadMoreSvg.parentElement;
      if (clickable) {
        clickable.click();
        return true;
      }
    }

    return false;
  }

  /**
   * FIXED: Get only UNLIKED comment like buttons.
   * Checks fill color — liked comments have red/pink fill.
   * Also deduplicates by parent li element.
   */
  function getUnlikedCommentButtons() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return [];

    // Find all comment like SVGs inside the dialog
    // Instagram structure: dialog > div > article > ... > ul > ul/div > li > div > span > button > svg
    const allCommentLikeSvgs = [...dialog.querySelectorAll('ul li svg[aria-label="Like"]')];

    const seen = new Set();
    const unliked = [];

    for (const svg of allCommentLikeSvgs) {
      const li = svg.closest('li');
      if (!li || seen.has(li)) continue;

      // FIXED: Check if comment is already liked
      // Instagram uses fill="rgb(237, 73, 86)" or fill="#ed4956" for liked comments
      const fill = svg.getAttribute('fill') || '';
      const color = svg.getAttribute('color') || '';

      const alreadyLiked =
        fill.includes('ed4956') || fill === 'rgb(237, 73, 86)' ||
        color.includes('ed4956') || color === 'rgb(237, 73, 86)';

      if (alreadyLiked) {
        seen.add(li);
        continue;
      }

      seen.add(li);
      unliked.push(svg);
    }

    return unliked;
  }

  /**
   * FIXED: Click the comment like button.
   */
  function likeComment(svg) {
    const clickable = svg.closest('button') ||
                      svg.closest('div[role="button"]') ||
                      svg.closest('span[role="button"]') ||
                      svg.closest('span')?.parentElement ||
                      svg.parentElement;
    if (!clickable) return false;
    clickable.click();
    return true;
  }

  /**
   * FIXED: Scroll the comment section to load more comments.
   */
  function scrollCommentSection() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return false;

    // Find the scrollable comment area
    // Usually it's a div with overflow-y: scroll inside the dialog
    const commentAreas = [...dialog.querySelectorAll('div')].filter(d => {
      try {
        const style = window.getComputedStyle(d);
        return (
          (style.overflowY === 'scroll' || style.overflowY === 'auto') &&
          d.scrollHeight > d.clientHeight + 20
        );
      } catch(e) { return false; }
    });

    if (commentAreas.length > 0) {
      // Sort by scroll height descending and scroll the most scrollable one
      commentAreas.sort((a, b) => b.scrollHeight - a.scrollHeight);
      const target = commentAreas[0];
      target.scrollTop = target.scrollHeight;
      return true;
    }

    // Fallback: scroll any overflow container
    const scrollables = [...dialog.querySelectorAll('div')].filter(d => {
      try { return d.scrollHeight > d.clientHeight + 30; } catch(e) { return false; }
    });
    if (scrollables.length > 0) {
      scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight)[0].scrollTop += 500;
      return true;
    }

    return false;
  }

  /**
   * FIXED: Check if we're in a post view.
   */
  function isInPostView() {
    // Dialog with article = post opened from feed
    if (document.querySelector('div[role="dialog"] article')) return true;
    // Direct post page (instagram.com/p/...)
    if (window.location.pathname.match(/\/p\//) && document.querySelector('article')) return true;
    return false;
  }

  /**
   * FIXED: Close the current post dialog.
   */
  async function closePost() {
    const dialog = document.querySelector('div[role="dialog"]');

    // Strategy 1: Close button with aria-label
    if (dialog) {
      const closeBtn = dialog.querySelector('button svg[aria-label="Close"]')?.closest('button') ||
                       dialog.querySelector('button svg[aria-label="Cerrar"]')?.closest('button') ||
                       dialog.querySelector('[role="button"][aria-label="Close"]') ||
                       null;
      if (closeBtn) {
        closeBtn.click();
        return true;
      }
    }

    // Strategy 2: Escape key
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    }));
    await sleep(500);

    // Strategy 3: Global close button (the × in top-right)
    const globalClose = document.querySelector('svg[aria-label="Close"]')?.closest('button');
    if (globalClose) {
      globalClose.click();
      return true;
    }

    return false;
  }

  // ======================== LIKE ALL COMMENTS (FIXED) ========================

  /**
   * FIXED: Like comments with proper limits and DOM handling.
   * - Max N comments per post (configurable)
   * - Checks fill color to skip already-liked
   * - Properly handles "Load more" buttons
   * - Stops early if no new comments load
   */
  async function likeAllComments(logArea, statusEl) {
    let commentsLiked = 0;
    let roundsWithoutNewComments = 0;
    const safeLimits = getSafeLimits();

    // FIXED: Hard cap per post to avoid burning limits on one viral post
    const perPostCap = Math.min(
      config.like.maxCommentsPerPost,
      safeLimits.perPostCap
    );

    // Wait for comments section to load
    await sleep(randDelay(1500, 3000));

    for (let round = 0; round < 80; round++) {
      if (stopped || !running) break;

      // FIXED: Check post cap — don't like more than N comments per post
      if (commentsLiked >= perPostCap) {
        if (logArea) logArea.textContent = `✅ Hit ${commentsLiked} comment cap on this post`;
        log(`Reached per-post comment cap (${commentsLiked})`);
        break;
      }

      // Check hourly limit
      if (state.hourlyCount >= safeLimits.hourlyCap) {
        if (statusEl) {
          statusEl.textContent = `⏳ Hit hourly cap (${state.hourlyCount})`;
          statusEl.style.background = '#ff6b9d22';
        }
        recordBlock('hourly_cap');
        break;
      }

      // Step 1: Try to load more comments
      const loadClicked = clickLoadMoreComments();
      if (loadClicked) {
        await sleep(randDelay(2000, 3500));
        roundsWithoutNewComments = 0;
        if (logArea) logArea.textContent = `📄 Loaded more comments (${commentsLiked} liked)`;
      }

      // Step 2: Scroll comment section
      scrollCommentSection();
      await sleep(randDelay(1000, 2000));

      // Step 3: Get unliked comments (FIXED: filters already liked by fill color)
      const unlikedSvgs = getUnlikedCommentButtons();

      if (unlikedSvgs.length > 0) {
        roundsWithoutNewComments = 0;

        for (const svg of unlikedSvgs) {
          if (stopped || !running) break;
          if (!document.contains(svg)) continue;

          // FIXED: Check per-post cap inside loop
          if (commentsLiked >= perPostCap) break;

          // Check hourly
          if (state.hourlyCount >= safeLimits.hourlyCap) {
            recordBlock('hourly_cap_mid_comment');
            break;
          }

          await humanHoverDelay();

          try {
            const success = likeComment(svg);
            if (success) {
              commentsLiked++;
              state.liked++;
              state.hourlyCount++;
              state.commentsLiked++;

              if (logArea) {
                logArea.textContent = `💬 Liked ${commentsLiked}/${perPostCap} comments (total: ${state.liked})`;
              }
              if (statusEl) {
                statusEl.textContent = `❤️${state.liked}`;
              }

              // Human-like delay between comment likes
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
          } catch(e) {
            log(`Error liking comment: ${e.message}`);
            state.consecutiveErrors++;
          }
        }
      } else {
        // No new unliked comments
        roundsWithoutNewComments++;

        if (roundsWithoutNewComments >= 4) {
          // Tried several times, no new comments — done with this post
          if (logArea) logArea.textContent = `✅ Liked ${commentsLiked} comments on this post`;
          log(`No more comments to like (${commentsLiked} total)`);
          break;
        }

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

  // ======================== MAIN ENGINE (FIXED) ========================

  async function instatakkerEngine() {
    state.startTime = state.startTime || Date.now();

    const safeLimits = getSafeLimits();

    // Show learned limits at start
    const logArea = document.getElementById('itk-log');
    const statusEl = document.getElementById('itk-status');

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
        if (logArea) logArea.textContent = '⏰ Hourly counter reset';
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

        // Wait 5-10 min then recheck
        await sleep(randDelay(300000, 600000));
        if (state.hourlyCount >= safeLimits.hourlyCap) {
          await sleep(Math.min(waitMs + 5000, 3600000));
        }

        state.hourlyCount = 0;
        state.hourlyReset = Date.now();

        if (statusEl) {
          statusEl.style.background = '';
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
        // ===================== LIKE MODE (FIXED) =====================

        // Rate limit warning
        const safe = getSafeLimits();
        if (state.hourlyCount >= safe.hourlyCap * 0.9) {
          if (logArea) logArea.textContent = `⚠️ Approaching limit (${state.hourlyCount}/${safe.hourlyCap})`;
          if (Math.random() < 0.3) {
            await sleep(randDelay(10000, 30000));
          }
        }

        // FIXED: Open a post if not already in one
        if (!isInPostView()) {
          // Look for post links in the feed
          const postLinks = document.querySelectorAll(
            'article a[href*="/p/"], article[role="presentation"] a, div[role="none"] a[href*="/p/"]'
          );

          // FIXED: Filter to actual post thumbnail links
          const validLinks = [...postLinks].filter(a => {
            const href = a.getAttribute('href') || '';
            return href.match(/\/p\//) && a.offsetParent !== null;
          });

          if (validLinks.length > 0) {
            // Pick a random post (not always the first)
            const postLink = validLinks[Math.floor(Math.random() * validLinks.length)];
            postLink.click();
            await sleep(randDelay(2000, 4000));
            if (logArea) logArea.textContent = `📱 Opened post (${state.liked} liked)`;
          } else {
            // FIXED: Try clicking an article
            const article = document.querySelector('article');
            if (article) {
              const firstLink = article.querySelector('a');
              if (firstLink && firstLink.href.includes('/p/')) {
                firstLink.click();
                await sleep(randDelay(2000, 4000));
                if (logArea) logArea.textContent = `📱 Opened post (${state.liked} liked)`;
              } else {
                if (logArea) logArea.textContent = '⚠️ No posts found. Navigate to a hashtag or feed.';
                await sleep(3000);
                continue;
              }
            } else {
              if (logArea) logArea.textContent = '⚠️ No posts found. Navigate to a hashtag or feed.';
              await sleep(3000);
              continue;
            }
          }
        }

        // Wait for post to fully load
        await sleep(randDelay(1500, 3000));

        if (!isInPostView()) {
          if (logArea) logArea.textContent = '⚠️ Click a post first';
          await sleep(2000);
          continue;
        }

        // --- Step 1: Like the post (FIXED: only likes the post, not comments) ---
        await humanHoverDelay();
        const likedPost = await likeCurrentPost();
        if (likedPost) {
          if (!isPostAlreadyLiked()) {
            state.liked++;
            state.hourlyCount++;
          }
          state.postsEngaged++;
          if (logArea) logArea.textContent = `❤️ Liked post ${state.postsEngaged} (${state.liked} total)`;
          if (statusEl) statusEl.textContent = `❤️${state.liked}`;
          log(`Liked post #${state.postsEngaged}`);

          // Human pause — "look" at the post
          await sleep(humanDelay(3000, 8000));
        } else {
          if (logArea) logArea.textContent = `⚠️ Could not like post (${state.liked} total)`;
        }

        // --- Step 2: Like COMMENTS (FIXED: max N per post, checks already-liked) ---
        if (logArea) logArea.textContent = `💬 Liking comments...`;
        const commentCount = await likeAllComments(logArea, statusEl);

        if (commentCount > 0) {
          log(`✅ Post ${state.postsEngaged}: liked ${commentCount} comments`);
          updateUI();
        } else {
          if (logArea) logArea.textContent = `💬 No new comments to like`;
        }

        // --- Step 3: Close post and move to next ---
        if (!stopped && running) {
          if (logArea) logArea.textContent = `➡️ Closing post and moving on...`;
          log('Closing post');

          const closed = await closePost();
          if (!closed) {
            // Try escape as fallback
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Escape',
              keyCode: 27,
              bubbles: true,
              cancelable: true
            }));
          }

          await sleep(randDelay(1500, 3000));

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
            <label style="font-size:10px;opacity:0.6;">Max unfollows:</label>
            <input type="number" id="itk-cfg-max" value="${config.unfollow.maxUnfollows}" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;margin:2px 0;">
            <label style="font-size:10px;opacity:0.6;">Hourly limit:</label>
            <input type="number" id="itk-cfg-hourly" value="${config.unfollow.hourlyLimit}" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;margin:2px 0;">
          </div>
          <div id="itk-settings-like" style="margin-top:6px;display:none;">
            <div style="font-size:10px;font-weight:600;color:#ff6b9d;margin-bottom:4px;">Like</div>
            <label style="font-size:10px;opacity:0.6;">Max likes:</label>
            <input type="number" id="itk-cfg-like-max" value="${config.like.maxLikes}" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;margin:2px 0;">
            <label style="font-size:10px;opacity:0.6;">Max comments/post:</label>
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
    const perpostDiv = panel.querySelector('#itk-perpost')?.parentElement?.parentElement;

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
      if (perpostDiv) perpostDiv.style.display = newMode === 'like' ? 'block' : 'none';

      updateUI();

      // Update the footer text
      const footer = panel.querySelector('div[style*="font-size:10px;opacity:0.4;margin-top:6px;"]');
      if (footer) {
        footer.textContent = newMode === 'unfollow'
          ? 'Following list → Enter'
          : '#hashtag or feed → Enter';
      }
    }

    unfollowTab.addEventListener('click', () => switchMode('unfollow'));
    likeTab.addEventListener('click', () => switchMode('like'));

    // FIXED: Apply settings button
    function applySettings() {
      const maxInput = document.getElementById('itk-cfg-max');
      const hourlyInput = document.getElementById('itk-cfg-hourly');
      const likeMaxInput = document.getElementById('itk-cfg-like-max');
      const likeCommentsInput = document.getElementById('itk-cfg-like-comments');

      if (maxInput) config.unfollow.maxUnfollows = parseInt(maxInput.value) || DEFAULTS.unfollow.maxUnfollows;
      if (hourlyInput) config.unfollow.hourlyLimit = parseInt(hourlyInput.value) || DEFAULTS.unfollow.hourlyLimit;
      if (likeMaxInput) config.like.maxLikes = parseInt(likeMaxInput.value) || DEFAULTS.like.maxLikes;
      if (likeCommentsInput) config.like.maxCommentsPerPost = parseInt(likeCommentsInput.value) || DEFAULTS.like.maxCommentsPerPost;
    }

    // Apply on blur / change
    panel.querySelectorAll('input[type="number"]').forEach(input => {
      input.addEventListener('change', applySettings);
      input.addEventListener('blur', applySettings);
    });
  }

  // ======================== KEYBOARD SHORTCUT (FIXED) ========================

  document.addEventListener('keydown', async (e) => {
    // Only on Enter key, not in an input field
    if (e.key === 'Enter' && e.target?.tagName !== 'INPUT' && e.target?.tagName !== 'TEXTAREA') {
      e.preventDefault();

      if (!running) {
        // Start
        stopped = false;
        running = true;
        state.emptyRounds = 0;
        state.consecutiveErrors = 0;

        // Save session state
        sessionStorage.setItem('instatakker_state', JSON.stringify({
          liked: state.liked,
          unfollowed: state.unfollowed,
          commentsLiked: state.commentsLiked,
          postsEngaged: state.postsEngaged,
          hourlyCount: state.hourlyCount,
        }));

        log(`Engine started in ${mode} mode`);
        const statusEl = document.getElementById('itk-status');
        if (statusEl) {
          statusEl.textContent = `▶ Running (${mode})`;
          statusEl.style.background = '#00ff8822';
          statusEl.style.border = '1px solid #00ff8844';
        }

        await instatakkerEngine();
        running = false;
      } else {
        // Stop
        stopped = true;
        running = false;
        log('Stopped by user');
        const statusEl = document.getElementById('itk-status');
        if (statusEl) {
          statusEl.textContent = `■ Stopped`;
          statusEl.style.background = '';
          statusEl.style.border = '';
        }
      }
    }
  });

  // ======================== INIT ========================

  // Create panel after page loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel);
  } else {
    createPanel();
  }

  console.log(
    `%c⏹ Instatakker v${VERSION} loaded`,
    'color: #ff0050; font-size: 14px; font-weight: bold;'
  );
  console.log(`%c${mode === 'unfollow' ? 'Unfollow' : 'Like'} mode | Press Enter to start`, 'color: #888; font-size: 12px;');

})();