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
      maxCommentsPerPost: 100,
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

  // ======================== POST ITERATOR ========================
  // Tracks which post we're on — sequential, top-to-bottom
  let postIterator = {
    index: 0,
    seenKeys: new Set(),
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
    if (pauseChance < 0.08) return randDelay(5000, 12000);
    if (pauseChance < 0.12) return randDelay(10000, 25000);
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

  // ======================== LIMIT TRACKING ========================

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

  // ======================== GET ALL VISIBLE POST LINKS (SEQUENTIAL) ========================

  function getAllPostLinks() {
    // Get all links to posts on the page (not in dialogs)
    const allLinks = [...document.querySelectorAll('a[href*="/p/"]')]
      .filter(a => {
        // Must be visible and not inside a dialog
        if (a.closest('div[role="dialog"]')) return false;
        try { return a.offsetParent !== null; } catch(e) { return false; }
      })
      .map(a => ({
        element: a,
        href: a.getAttribute('href'),
        rect: a.getBoundingClientRect(),
      }));

    // Deduplicate by href
    const seen = new Set();
    const unique = [];
    for (const item of allLinks) {
      if (seen.has(item.href)) continue;
      seen.add(item.href);
      unique.push(item);
    }

    // Sort top-to-bottom on the page
    unique.sort((a, b) => a.rect.top - b.rect.top);

    return unique;
  }

  function getNextUnprocessedPost() {
    const posts = getAllPostLinks();
    // Walk through sequentially from current index
    for (let i = postIterator.index; i < posts.length; i++) {
      if (!postIterator.seenKeys.has(posts[i].href)) {
        postIterator.index = i;
        return posts[i];
      }
    }
    return null;
  }

  function markPostProcessed(href) {
    postIterator.seenKeys.add(href);
    postIterator.index++;
  }

  async function openNextPost(logArea) {
    const post = getNextUnprocessedPost();
    if (!post) {
      if (logArea) logArea.textContent = '✅ All visible posts processed.';
      return null;
    }

    log(`Opening post: ${post.href} (#${postIterator.index})`);
    if (logArea) {
      logArea.textContent = `📱 Opening post #${state.postsEngaged + 1}...`;
    }

    // Scroll into view first so it's clickable
    try {
      post.element.scrollIntoView({ block: 'center' });
      await sleep(randDelay(500, 1000));
    } catch(e) {}

    // Click the post link
    post.element.click();
    await sleep(randDelay(2000, 3500));

    // Wait for dialog to appear
    for (let i = 0; i < 30; i++) {
      if (stopped || !running) return null;
      if (document.querySelector('div[role="dialog"] article')) {
        markPostProcessed(post.href);
        log(`✅ Dialog opened for ${post.href}`);
        return true;
      }
      await sleep(400);
    }

    // Fallback: try clicking parent
    const parentDiv = post.element.closest('div[class*="html-div"], div[class*="x1iyjqo2"]');
    if (parentDiv && parentDiv !== post.element) {
      parentDiv.click();
      await sleep(2000);
      for (let i = 0; i < 20; i++) {
        if (stopped || !running) return null;
        if (document.querySelector('div[role="dialog"] article')) {
          markPostProcessed(post.href);
          return true;
        }
        await sleep(400);
      }
    }

    // Skipping this post — dialog never opened
    log(`⚠️ Could not open dialog for ${post.href} — skipping`);
    markPostProcessed(post.href);
    return false;
  }

  // ======================== LIKE POST ========================

  function getPostLikeButton() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return null;

    const article = dialog.querySelector('article');
    if (article) {
      const likeSvg = article.querySelector('section svg[aria-label="Like"], section svg[aria-label="Unlike"]');
      if (likeSvg) return likeSvg;
    }

    const allLikeSvgs = [...dialog.querySelectorAll('svg[aria-label="Like"]')];
    for (const svg of allLikeSvgs) {
      const inComment = svg.closest('ul ul') || svg.closest('li div[role="button"]');
      if (!inComment) return svg;
    }

    const article2 = document.querySelector('article');
    if (article2) {
      const likeSvg = article2.querySelector('section svg[aria-label="Like"], section svg[aria-label="Unlike"]');
      if (likeSvg) return likeSvg;
    }

    return null;
  }

  function isPostAlreadyLiked() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (dialog) {
      const article = dialog.querySelector('article');
      if (article) {
        return !!article.querySelector('section svg[aria-label="Unlike"]');
      }
    }
    return !!document.querySelector('article section svg[aria-label="Unlike"]');
  }

  async function likeCurrentPost() {
    if (isPostAlreadyLiked()) {
      log('Post already liked, skipping');
      return true;
    }

    const likeSvg = getPostLikeButton();
    if (!likeSvg) {
      log('Post like button not found');
      return false;
    }

    const clickable = likeSvg.closest('button') ||
                      likeSvg.closest('div[role="button"]') ||
                      likeSvg.closest('span[role="button"]') ||
                      likeSvg.parentElement;
    if (!clickable) return false;

    clickable.click();
    await sleep(500);
    return true;
  }

  // ======================== LIKE COMMENTS ========================

  function clickLoadMoreComments() {
    const dialog = document.querySelector('div[role="dialog"]');

    // Load more comments button
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

    // SVG-based load more
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

  function getUnlikedCommentButtons() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return [];

    const allCommentLikeSvgs = [...dialog.querySelectorAll('ul li svg[aria-label="Like"]')];

    const seen = new Set();
    const unliked = [];

    for (const svg of allCommentLikeSvgs) {
      const li = svg.closest('li');
      if (!li || seen.has(li)) continue;

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

  function scrollCommentSection() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return false;

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
      commentAreas.sort((a, b) => b.scrollHeight - a.scrollHeight);
      const target = commentAreas[0];
      target.scrollTop = target.scrollHeight;
      return true;
    }

    const scrollables = [...dialog.querySelectorAll('div')].filter(d => {
      try { return d.scrollHeight > d.clientHeight + 30; } catch(e) { return false; }
    });
    if (scrollables.length > 0) {
      scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight)[0].scrollTop += 500;
      return true;
    }

    return false;
  }

  function isInPostView() {
    if (document.querySelector('div[role="dialog"] article')) return true;
    if (window.location.pathname.match(/\/p\//) && document.querySelector('article')) return true;
    return false;
  }

  async function closePost() {
    const dialog = document.querySelector('div[role="dialog"]');

    if (dialog) {
      const closeBtn = dialog.querySelector('button svg[aria-label="Close"]')?.closest('button') ||
                       dialog.querySelector('button svg[aria-label="Cerrar"]')?.closest('button') ||
                       dialog.querySelector('[role="button"][aria-label="Close"]') ||
                       null;
      if (closeBtn) {
        closeBtn.click();
        await sleep(800);
        for (let i = 0; i < 15; i++) {
          if (!document.querySelector('div[role="dialog"] article')) return true;
          await sleep(300);
        }
      }
    }

    // Escape key fallback
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    }));
    await sleep(500);

    // Global close button
    const globalClose = document.querySelector('svg[aria-label="Close"]')?.closest('button');
    if (globalClose) {
      globalClose.click();
      await sleep(500);
    }

    for (let i = 0; i < 10; i++) {
      if (!document.querySelector('div[role="dialog"] article')) return true;
      await sleep(300);
    }

    return !document.querySelector('div[role="dialog"] article');
  }

  // ======================== LIKE ALL COMMENTS (scroll comments for more) ========================

  async function likeAllComments(logArea, statusEl) {
    let commentsLiked = 0;
    let roundsWithoutNewComments = 0;
    const safeLimits = getSafeLimits();

    const perPostCap = Math.min(
      config.like.maxCommentsPerPost,
      safeLimits.perPostCap
    );

    await sleep(randDelay(1500, 3000));

    for (let round = 0; round < 80; round++) {
      if (stopped || !running) break;

      if (commentsLiked >= perPostCap) {
        if (logArea) logArea.textContent = `✅ Hit ${commentsLiked} comment cap on this post`;
        log(`Reached per-post comment cap (${commentsLiked})`);
        break;
      }

      if (state.hourlyCount >= safeLimits.hourlyCap) {
        if (statusEl) {
          statusEl.textContent = `⏳ Hit hourly cap (${state.hourlyCount})`;
          statusEl.style.background = '#ff6b9d22';
        }
        recordBlock('hourly_cap');
        break;
      }

      // Click "Load more comments" button
      const loadClicked = clickLoadMoreComments();
      if (loadClicked) {
        await sleep(randDelay(2000, 3500));
        roundsWithoutNewComments = 0;
        if (logArea) logArea.textContent = `📄 Loaded more comments (${commentsLiked} liked)`;
      }

      // Scroll within the comment section to trigger lazy loading
      scrollCommentSection();
      await sleep(randDelay(1000, 2000));

      // Find unliked comments
      const unlikedSvgs = getUnlikedCommentButtons();

      if (unlikedSvgs.length > 0) {
        roundsWithoutNewComments = 0;

        for (const svg of unlikedSvgs) {
          if (stopped || !running) break;
          if (!document.contains(svg)) continue;

          if (commentsLiked >= perPostCap) break;

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
        roundsWithoutNewComments++;

        if (roundsWithoutNewComments >= 4) {
          if (logArea) logArea.textContent = `✅ Liked ${commentsLiked} comments on this post`;
          log(`No more comments to like (${commentsLiked} total)`);
          break;
        }

        await sleep(randDelay(2000, 4000));
      }

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

    const safeLimits = getSafeLimits();

    const logArea = document.getElementById('itk-log');
    const statusEl = document.getElementById('itk-status');

    // Reset post iterator on each engine start
    postIterator.index = 0;
    postIterator.seenKeys = new Set();

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

        await sleep(randDelay(300000, 600000));
        if (state.hourlyCount >= safeLimits.hourlyCap) {
          await sleep(Math.min(waitMs + 5000, 3600000));
        }

        state.hourlyCount = 0;
        state.hourlyReset = Date.now();
        if (statusEl) statusEl.style.background = '';
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
        // ===================== LIKE MODE — AUTO NEXT POST =====================

        const safe = getSafeLimits();
        if (state.hourlyCount >= safe.hourlyCap * 0.9) {
          if (logArea) logArea.textContent = `⚠️ Approaching limit (${state.hourlyCount}/${safe.hourlyCap})`;
          if (Math.random() < 0.3) {
            await sleep(randDelay(10000, 30000));
          }
        }

        // --- Open the next unprocessed post (sequential, no page scrolling) ---
        const opened = await openNextPost(logArea);
        if (opened === null) {
          // No more unprocessed posts — we're done
          if (logArea) {
            const count = state.liked;
            logArea.textContent = `✅ Done — liked ${count} posts, ${state.commentsLiked} comments across ${state.postsEngaged} posts`;
          }
          log('All visible posts processed. Stopping.');
          break;
        }

        if (!opened) {
          // Couldn't open dialog for this post but skipped it — continue to next
          continue;
        }

        // Wait for post to fully load
        await sleep(randDelay(1500, 3000));

        // --- Step 1: Like the post ---
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

          await sleep(humanDelay(3000, 8000));
        } else {
          if (logArea) logArea.textContent = `⚠️ Could not like post (${state.liked} total)`;
        }

        // --- Step 2: Like all COMMENTS (scrolling within the comment section) ---
        if (logArea) logArea.textContent = `💬 Liking comments on post #${state.postsEngaged}...`;
        const commentCount = await likeAllComments(logArea, statusEl);

        if (commentCount > 0) {
          log(`✅ Post ${state.postsEngaged}: liked ${commentCount} comments`);
          updateUI();
        } else {
          if (logArea) logArea.textContent = `💬 No new comments to like`;
        }

        // --- Step 3: Close the post — loop will open the next one ---
        if (!stopped && running) {
          if (logArea) logArea.textContent = `➡️ Closing post #${state.postsEngaged}...`;
          log('Closing post');

          await closePost();
          await sleep(randDelay(1500, 3000));

          // Small nudge to reposition after dialog closes
          await humanScroll(200);
          await sleep(randDelay(1000, 2000));

          // Update UI stats
          recordSafeOperation();
          const newsafe = getSafeLimits();
          const avgComments = state.postsEngaged > 0
            ? Math.round(state.commentsLiked / state.postsEngaged)
            : 0;

          if (logArea) {
            const remaining = getAllPostLinks().filter(p => !postIterator.seenKeys.has(p.href)).length;
            logArea.textContent = `📊 ${state.liked} liked | ${state.hourlyCount}/${newsafe.hourlyCap}/hr | ~${avgComments}/post | ${remaining} remaining`;
          }
        }
      }
    }

    running = false;
    if (logArea) {
      if (!logArea.textContent.includes('Done') && !logArea.textContent.includes('processed')) {
        const count = mode === 'unfollow' ? state.unfollowed : state.liked;
        const action = mode === 'unfollow' ? 'unfollowed' : 'liked';
        logArea.textContent = `■ Stopped (${count} ${action}, ${state.commentsLiked} comments)`;
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
          ${mode === 'unfollow' ? 'Following list → Enter' : 'Auto-advances to next post'}
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

      const footer = panel.querySelector('div[style*="font-size:10px;opacity:0.4;margin-top:6px;"]');
      if (footer) {
        footer.textContent = newMode === 'unfollow'
          ? 'Following list → Enter'
          : 'Auto-advances to next post';
      }
    }

    unfollowTab.addEventListener('click', () => switchMode('unfollow'));
    likeTab.addEventListener('click', () => switchMode('like'));

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

    panel.querySelectorAll('input[type="number"]').forEach(input => {
      input.addEventListener('change', applySettings);
      input.addEventListener('blur', applySettings);
    });
  }

  // ======================== KEYBOARD SHORTCUT ========================

  document.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && e.target?.tagName !== 'INPUT' && e.target?.tagName !== 'TEXTAREA') {
      e.preventDefault();

      if (!running) {
        stopped = false;
        running = true;
        state.emptyRounds = 0;
        state.consecutiveErrors = 0;

        // Reset post iterator on each start
        postIterator.index = 0;
        postIterator.seenKeys = new Set();

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
          statusEl.textContent = `▶ Running (${mode}${mode === 'like' ? ' — auto-advancing' : ''})`;
          statusEl.style.background = '#00ff8822';
          statusEl.style.border = '1px solid #00ff8844';
        }

        await instatakkerEngine();
        running = false;
      } else {
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

  // ======================== INSTATAKKER API ========================

  window.Instatakker = {
    start: async function(selectedMode) {
      if (running) return;
      if (selectedMode && ['like', 'unfollow'].includes(selectedMode)) mode = selectedMode;

      stopped = false;
      running = true;
      state.emptyRounds = 0;
      state.consecutiveErrors = 0;

      postIterator.index = 0;
      postIterator.seenKeys = new Set();

      log(`API start in ${mode} mode`);
      await instatakkerEngine();
      running = false;
    },

    stop: function() {
      stopped = true;
      running = false;
      log('API stop');
    },

    status: function() {
      return {
        running, mode,
        state: { ...state },
        config: { ...config },
        limits: {
          learnedHourlyCap: limits.learnedHourlyCap,
          learnedPerPostCap: limits.learnedPerPostCap,
          blockCount: limits.blockHistory.length,
          totalSessions: limits.totalSessions,
        },
        postIterator: { index: postIterator.index, seenKeys: postIterator.seenKeys.size },
        version: VERSION,
      };
    },

    resetLimits: function() {
      limits = {
        blockHistory: [], learnedHourlyCap: 200, learnedPerPostCap: 150,
        totalSessions: limits.totalSessions, lastUpdated: null,
        maxSafeHourly: 0, maxSafePerPost: 0,
      };
      saveLimits(limits);
      log('🧹 Limits reset');
    },

    version: VERSION,
  };

  // ======================== INIT ========================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel);
  } else {
    createPanel();
  }

  console.log(
    `%c⏹ Instatakker v${VERSION} loaded with auto-advance`,
    'color: #ff0050; font-size: 14px; font-weight: bold;'
  );
  console.log(`%c🔄 Auto-advances to next post after finishing each one`, 'color: #888; font-size: 12px;');
  console.log(`%c${mode === 'unfollow' ? 'Unfollow' : 'Like'} mode | Press Enter to start`, 'color: #888; font-size: 12px;');

})();