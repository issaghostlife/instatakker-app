// ==UserScript==
// @name         Instatakker
// @namespace    http://instatakker.io
// @version      2.0.1
// @description  Instagram automation — unfollow + like everything (posts + comments) like a human
// @author       Instatakker
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  const VERSION = '2.0.1';

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
  let mode = 'like';

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

  // Sequential post index — goes in order, resets when scrolling loads new posts
  let currentPostIndex = 0;

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

  // ======================== LIMIT TRACKING (LEARNING) ========================

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
      learnedPerPostCap: 100,
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
      action,
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
      limits.learnedPerPostCap = Math.max(10, Math.round(limits.learnedHourlyCap / 4));
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
    // Conservative start for new accounts
    return {
      hourlyCap: Math.min(config.like.hourlyLimit, 80),
      perPostCap: Math.min(config.like.maxCommentsPerPost, 40),
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

  // ======================== POST SELECTION (FIXED — YOUR EXACT DIV) ========================

  /**
   * FIXED: Get all post divs using the EXACT structure you provided:
   *
   * <div class="html-div xdj266r x14z9mp ... x1nhvcw1">                          ← OUTER (this is what we click)
   *   <div class="xuk3077 x972fbf ... x11njtxf">                                  ← MIDDLE
   *     <div class="html-div xexx8yu ... x1nhvcw1">                               ← INNER
   *       <svg aria-label="Carousel" class="..." height="20" role="img"...>       ← CAROUSEL SVG
   *     </div>
   *   </div>
   * </div>
   *
   * We find the Carousel SVG, then climb up to the outermost clickable div.
   */
  function getPostDivs() {
    // Find all carousel SVGs (most posts have this)
    const carouselSvgs = [
      ...document.querySelectorAll(
        'svg[aria-label="Carousel"]'
      )
    ];

    const postDivs = [];

    // Track seen articles to deduplicate
    const seenArticles = new Set();

    for (const svg of carouselSvgs) {
      // Climb up to the outermost clickable div
      // Your structure: svg inside inner div > inside middle div > inside outer div
      const innerDiv = svg.closest('div.html-div');
      if (!innerDiv) continue;

      // Get the parent of innerDiv — this should be the "xuk3077" div
      const middleDiv = innerDiv.parentElement;
      if (!middleDiv) continue;

      // Get the parent of middleDiv — this is the OUTER clickable div
      const outerDiv = middleDiv.parentElement;
      if (!outerDiv) continue;

      // Verify it's visible and inside an article
      if (!outerDiv.offsetParent) continue;
      const article = outerDiv.closest('article');
      if (!article) continue;

      // Deduplicate by article
      const articleKey = article.dataset?.index || article.innerHTML?.substring(0, 50);
      if (seenArticles.has(articleKey)) continue;
      seenArticles.add(articleKey);

      postDivs.push({
        outerDiv,  // The clickable element
        middleDiv,
        innerDiv,
        svg,
        article
      });
    }

    // Also catch posts without carousel SVGs (single image posts)
    // These are typically direct div children of article
    const allArticles = document.querySelectorAll('article');
    for (const article of allArticles) {
      const articleKey = article.dataset?.index || article.innerHTML?.substring(0, 50);
      if (seenArticles.has(articleKey)) continue;

      // Find divs that look like post containers
      const possiblePostDivs = article.querySelectorAll(
        'div[class*="html-div"][class*="x78zum5"]'
      );

      for (const div of possiblePostDivs) {
        if (!div.offsetParent) continue;
        // Skip if it's already part of a carousel post
        if (postDivs.some(p => p.article === article)) break;

        // Check if this div has an anchor to /p/ or looks clickable
        if (div.querySelector('a[href*="/p/"]') || div.querySelector('img')) {
          seenArticles.add(articleKey);
          postDivs.push({
            outerDiv: div,
            middleDiv: null,
            innerDiv: null,
            svg: null,
            article
          });
          break;
        }
      }
    }

    // Sort by vertical position on screen (top to bottom = sequential order)
    postDivs.sort((a, b) => {
      const rectA = a.outerDiv.getBoundingClientRect();
      const rectB = b.outerDiv.getBoundingClientRect();
      return rectA.top - rectB.top;
    });

    return postDivs;
  }

  /**
   * FIXED: Opens posts SEQUENTIALLY (in order, top to bottom).
   * Uses currentPostIndex to track position.
   * Scrolls to load more when reaching the end.
   */
  async function openNextPost(logArea) {
    const posts = getPostDivs();

    if (posts.length === 0) {
      if (logArea) logArea.textContent = '⚠️ No posts found in feed';
      return false;
    }

    // If we've gone through all visible posts, scroll to load more
    if (currentPostIndex >= posts.length) {
      if (logArea) logArea.textContent = `📜 Scrolling for more posts...`;
      await humanScroll(1500);
      await sleep(randDelay(2500, 4000));

      // Re-query for new posts
      const newPosts = getPostDivs();
      if (newPosts.length <= posts.length) {
        // No new posts loaded — try scrolling more aggressively
        await humanScroll(2000);
        await sleep(3000);
        const retryPosts = getPostDivs();
        if (retryPosts.length <= posts.length) {
          if (logArea) logArea.textContent = '⚠️ No more posts to load';
          return false;
        }
        // Continue from where we left off
        currentPostIndex = posts.length;
      } else {
        // New posts loaded
        currentPostIndex = posts.length;
      }
    }

    // Safety check — prevent out of bounds
    const allPosts = getPostDivs();
    if (currentPostIndex >= allPosts.length) {
      currentPostIndex = 0;
    }

    const post = allPosts[currentPostIndex];
    if (!post || !post.outerDiv) {
      currentPostIndex++;
      return false;
    }

    log(`Opening post #${currentPostIndex + 1}/${allPosts.length}`);
    if (logArea) {
      logArea.textContent = `📱 Opening post #${currentPostIndex + 1}/${allPosts.length} (${state.liked} liked)`;
    }

    // Scroll the post into view first
    try {
      post.outerDiv.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(randDelay(800, 1500));
    } catch(e) {}

    // CLICK THE OUTER DIV — your exact element
    post.outerDiv.click();
    await sleep(randDelay(2500, 4000));

    // Wait for dialog to appear
    for (let i = 0; i < 30; i++) {
      if (stopped || !running) return false;
      if (document.querySelector('div[role="dialog"] article')) {
        currentPostIndex++;
        log(`Post #${currentPostIndex} opened successfully`);
        return true;
      }
      await sleep(400);
    }

    // If dialog didn't appear, try clicking the inner area
    if (post.middleDiv) {
      post.middleDiv.click();
      await sleep(3000);
      for (let i = 0; i < 20; i++) {
        if (document.querySelector('div[role="dialog"] article')) {
          currentPostIndex++;
          return true;
        }
        await sleep(400);
      }
    }

    log('Post dialog did not appear — skipping');
    currentPostIndex++;
    return false;
  }

  // ======================== LIKE POST ========================

  function getPostLikeButton() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return null;

    // Post like: height="24" vs comment like: height="12"
    const postLikeSvg = dialog.querySelector(
      'article svg[aria-label="Like"][height="24"], article svg[aria-label="Unlike"][height="24"]'
    );
    if (postLikeSvg) return postLikeSvg;

    // Fallback
    const allLikeSvgs = [...dialog.querySelectorAll('svg[aria-label="Like"][height="24"]')];
    for (const svg of allLikeSvgs) {
      if (!svg.closest('ul') && !svg.closest('li')) return svg;
    }
    return null;
  }

  function isPostAlreadyLiked() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return false;
    return !!dialog.querySelector('article svg[aria-label="Unlike"]');
  }

  async function likeCurrentPost() {
    if (isPostAlreadyLiked()) {
      log('Post already liked');
      return 'already_liked';
    }

    const likeSvg = getPostLikeButton();
    if (!likeSvg) {
      log('Post like button not found');
      return false;
    }

    const clickable = likeSvg.closest('button') ||
                      likeSvg.closest('div[role="button"]') ||
                      likeSvg.closest('span')?.parentElement;
    if (!clickable) return false;

    await humanHoverDelay();
    clickable.click();
    await sleep(randDelay(500, 1000));
    return true;
  }

  // ======================== LIKE COMMENTS ========================

  function clickLoadMoreComments() {
    // Your exact circle SVG
    const circle = document.querySelector(
      'circle[cx="12.001"][cy="12.005"][r="10.5"][stroke-linecap="round"]'
    );
    if (circle) {
      const btn = circle.closest('button') || circle.closest('div[role="button"]');
      if (btn && btn.offsetParent) {
        btn.click();
        return true;
      }
    }

    // Fallback
    const dialog = document.querySelector('div[role="dialog"]');
    if (dialog) {
      for (const btn of dialog.querySelectorAll('button')) {
        const text = (btn.innerText || '').trim().toLowerCase();
        if (text.includes('load more') || text.includes('view all')) {
          btn.click();
          return true;
        }
      }
    }
    return false;
  }

  function getUnlikedCommentButtons() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return [];

    // Comment likes: height="12"
    const commentLikeSvgs = [...dialog.querySelectorAll('svg[aria-label="Like"][height="12"]')];

    const seen = new Set();
    const unliked = [];

    for (const svg of commentLikeSvgs) {
      const li = svg.closest('li');
      if (!li || seen.has(li)) continue;
      seen.add(li);

      const fill = svg.getAttribute('fill') || '';
      const color = svg.getAttribute('color') || '';

      let liked = false;
      if (fill !== 'currentColor' && fill !== '' && fill !== 'none') {
        if (fill.startsWith('rgb(') || fill.startsWith('#ed') || fill.startsWith('#ff') || fill.startsWith('#fe')) {
          liked = true;
        }
      }

      if (!liked) unliked.push(svg);
    }

    return unliked;
  }

  function likeComment(svg) {
    const clickable = svg.closest('button') ||
                      svg.closest('div[role="button"]') ||
                      svg.closest('span')?.parentElement;
    if (!clickable || !clickable.offsetParent) return false;
    clickable.click();
    return true;
  }

  function scrollCommentSection() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return false;

    const scrollables = [...dialog.querySelectorAll('div')].filter(d => {
      try {
        const style = window.getComputedStyle(d);
        return (
          (style.overflowY === 'scroll' || style.overflowY === 'auto') &&
          d.scrollHeight > d.clientHeight + 20
        );
      } catch(e) { return false; }
    });

    if (scrollables.length > 0) {
      scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight);
      scrollables[0].scrollTop = scrollables[0].scrollHeight;
      return true;
    }
    return false;
  }

  async function closePost() {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', keyCode: 27, which: 27,
      bubbles: true, cancelable: true
    }));
    await sleep(800);

    if (document.querySelector('div[role="dialog"]')) {
      const closeSvg = document.querySelector('svg[aria-label="Close"]');
      if (closeSvg) {
        const btn = closeSvg.closest('button');
        if (btn) btn.click();
        await sleep(800);
      }
    }

    for (let i = 0; i < 15; i++) {
      if (!document.querySelector('div[role="dialog"] article')) return true;
      await sleep(300);
    }
    return !document.querySelector('div[role="dialog"] article');
  }

  // ======================== LIKE ALL COMMENTS ========================

  async function likeAllComments(logArea, statusEl) {
    let commentsLiked = 0;
    let roundsWithoutNewComments = 0;
    const safeLimits = getSafeLimits();

    const perPostCap = Math.min(
      config.like.maxCommentsPerPost,
      safeLimits.perPostCap
    );

    await sleep(randDelay(2000, 3500));

    for (let round = 0; round < 80; round++) {
      if (stopped || !running) break;

      if (commentsLiked >= perPostCap) {
        if (logArea) logArea.textContent = `✅ Hit ${commentsLiked} comment cap on this post`;
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

      const loadClicked = clickLoadMoreComments();
      if (loadClicked) {
        await sleep(randDelay(2000, 3500));
        roundsWithoutNewComments = 0;
      }

      scrollCommentSection();
      await sleep(randDelay(1000, 2000));

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
                logArea.textContent = `💬 Liked ${commentsLiked}/${perPostCap} (total: ${state.liked})`;
              }
              if (statusEl) statusEl.textContent = `❤️${state.liked}`;
              updateUI();

              await sleep(humanDelay(
                config.like.minCommentDelay,
                config.like.maxCommentDelay
              ));
            } else {
              state.consecutiveErrors++;
              if (state.consecutiveErrors > 5) {
                await sleep(10000);
                state.consecutiveErrors = 0;
              }
              await sleep(500);
            }
          } catch(e) {
            log(`Error: ${e.message}`);
            state.consecutiveErrors++;
          }
        }
      } else {
        roundsWithoutNewComments++;
        if (roundsWithoutNewComments >= 4) {
          if (logArea) logArea.textContent = `✅ Liked ${commentsLiked} comments on this post`;
          break;
        }
        await sleep(randDelay(2000, 4000));
      }

      if (round % 5 === 0) recordSafeOperation();
    }

    state.postsEngaged++;
    return commentsLiked;
  }

  // ======================== MAIN ENGINE ========================

  async function instatakkerEngine() {
    const logArea = document.getElementById('itk-log');
    const statusEl = document.getElementById('itk-status');
    const safeLimits = getSafeLimits();

    // Reset index when starting fresh
    currentPostIndex = 0;

    if (limits.blockHistory.length >= 2) {
      if (logArea) logArea.textContent = `🧠 Learned: ${safeLimits.hourlyCap}/hr, ${safeLimits.perPostCap}/post`;
    } else {
      if (logArea) logArea.textContent = `🆕 Conservative: ${safeLimits.hourlyCap}/hr, ${safeLimits.perPostCap}/post`;
    }

    while (running && !stopped) {
      // Hourly reset
      if (Date.now() - state.hourlyReset > 3600000) {
        state.hourlyCount = 0;
        state.hourlyReset = Date.now();
        if (logArea) logArea.textContent = '⏰ Hourly reset';
      }

      // Check hourly cap (LEARNED)
      if (state.hourlyCount >= safeLimits.hourlyCap) {
        const waitMin = Math.ceil((3600000 - (Date.now() - state.hourlyReset)) / 60000);
        if (logArea) logArea.textContent = `⏳ Hit ${state.hourlyCount}/${safeLimits.hourlyCap} cap — waiting ${waitMin}min`;
        if (statusEl) {
          statusEl.textContent = `⏳ Waiting ${waitMin}min`;
          statusEl.style.background = '#ff6b9d22';
        }
        recordBlock('hourly_cap_reached');
        await sleep(randDelay(300000, 600000));
        if (state.hourlyCount >= safeLimits.hourlyCap) {
          await sleep(Math.min((3600000 - (Date.now() - state.hourlyReset)) + 5000, 3600000));
        }
        state.hourlyCount = 0;
        state.hourlyReset = Date.now();
        if (statusEl) statusEl.style.background = '';
        continue;
      }

      // Check total cap
      if (state.liked >= config.like.maxLikes) {
        if (logArea) logArea.textContent = `✅ Done: liked ${state.liked}`;
        break;
      }

      // --- OPEN NEXT POST IN ORDER (sequential, not random) ---
      const opened = await openNextPost(logArea);
      if (!opened) {
        if (logArea) logArea.textContent = '⚠️ No more posts. Scroll or navigate to feed.';
        await sleep(3000);
        continue;
      }

      // --- LIKE THE POST ---
      await humanHoverDelay();
      const postResult = await likeCurrentPost();

      if (postResult === true) {
        state.liked++;
        state.hourlyCount++;
        state.postsEngaged++;
        if (logArea) logArea.textContent = `❤️ Liked post #${state.postsEngaged} (${state.liked} total, ${state.hourlyCount}/${safeLimits.hourlyCap}hr)`;
        if (statusEl) statusEl.textContent = `❤️${state.liked}`;
        log(`Liked post #${state.postsEngaged}`);
        await sleep(humanDelay(3000, 8000));
      } else if (postResult === 'already_liked') {
        if (logArea) logArea.textContent = `📌 Already liked (${state.liked} total)`;
        state.postsEngaged++;
        await sleep(randDelay(1500, 3000));
      } else {
        if (logArea) logArea.textContent = `⚠️ Like button not found (${state.liked} total)`;
        await sleep(randDelay(1500, 3000));
      }

      // --- LIKE ALL COMMENTS (respects LEARNED per-post cap) ---
      if (logArea) logArea.textContent = `💬 Liking comments...`;
      const commentCount = await likeAllComments(logArea, statusEl);
      if (commentCount > 0) {
        log(`✅ Liked ${commentCount} comments on post #${state.postsEngaged}`);
        updateUI();
      } else {
        if (logArea) logArea.textContent = `💬 No comments to like`;
      }

      // --- CLOSE POST ---
      if (!stopped && running) {
        if (logArea) logArea.textContent = `➡️ Closing post...`;
        await closePost();
        await sleep(randDelay(1500, 3000));

        // Small scroll to move past the closed post
        await humanScroll(400);
        await sleep(randDelay(1500, 3000));

        // Update learning
        recordSafeOperation();
        const avgComments = state.postsEngaged > 0
          ? Math.round(state.commentsLiked / state.postsEngaged)
          : 0;
        if (logArea) {
          logArea.textContent = `📊 ${state.liked} liked | ${state.hourlyCount}/${safeLimits.hourlyCap}hr | ~${avgComments}/post`;
        }
      }
    }

    running = false;
    if (logArea && !logArea.textContent.includes('Done')) {
      logArea.textContent = `■ Stopped (${state.liked} liked, ${state.commentsLiked} comments)`;
    }
    if (statusEl) {
      statusEl.textContent = `■`;
      statusEl.style.background = '';
    }

    saveLimits(limits);
    log(`Stopped. ${limits.totalSessions} sessions. Learned: ${limits.learnedHourlyCap}/hr, ${limits.learnedPerPostCap}/post`);
  }

  // ======================== UI ========================

  function updateUI() {
    const countEl = document.getElementById('itk-count');
    const progressEl = document.getElementById('itk-progress');
    const barEl = document.getElementById('itk-bar');
    const hourlyEl = document.getElementById('itk-hourly');
    const engagedEl = document.getElementById('itk-engaged');

    if (countEl) countEl.textContent = state.liked;
    if (progressEl) progressEl.textContent = `${state.liked} / ${config.like.maxLikes}`;
    if (barEl) barEl.style.width = `${(state.liked / config.like.maxLikes) * 100}%`;
    if (hourlyEl) hourlyEl.textContent = `${state.hourlyCount} / ${getSafeLimits().hourlyCap}`;
    if (engagedEl) engagedEl.textContent = state.commentsLiked;
  }

  function createPanel() {
    const existing = document.getElementById('instatakker-panel');
    if (existing) existing.remove();

    try {
      const saved = sessionStorage.getItem('instatakker_state');
      if (saved) state = { ...state, ...JSON.parse(saved) };
    } catch(e) {}

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
          <button id="itk-mode-like" style="flex:1;padding:6px 10px;border:none;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer;background:#ff0050;color:white;transition:all 0.2s;">Like</button>
          <button id="itk-mode-unfollow" style="flex:1;padding:6px 10px;border:none;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer;background:transparent;color:#888;transition:all 0.2s;">Unfollow</button>
        </div>

        ${hasLearned ? `
        <div style="font-size:10px;color:#ff6b9d;background:#ff6b9d10;padding:4px 8px;border-radius:4px;margin-bottom:8px;border:1px solid #ff6b9d25;display:flex;justify-content:space-between;">
          <span>🧠 ${limits.totalSessions} sessions</span>
          <span>max ${limits.learnedHourlyCap}/hr safe</span>
        </div>
        ` : `
        <div style="font-size:10px;color:#888;background:#1a1a2e;padding:4px 8px;border-radius:4px;margin-bottom:8px;text-align:center;">
          New — learning limits as you go
        </div>
        `}

        <div id="itk-status" style="font-size:12px;padding:6px 10px;background:#1a1a2e;border-radius:6px;margin-bottom:8px;text-align:center;border:1px solid transparent;transition:all 0.2s;">
          Press <kbd style="background:#333;padding:1px 5px;border-radius:3px;border:1px solid #555;font-size:11px;">Enter</kbd> to start
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
          <div style="background:#1a1a2e;border-radius:6px;padding:6px 8px;">
            <div style="font-size:10px;opacity:0.5;">Liked</div>
            <div style="font-weight:700;font-size:16px;" id="itk-count">${state.liked}</div>
          </div>
          <div style="background:#1a1a2e;border-radius:6px;padding:6px 8px;">
            <div style="font-size:10px;opacity:0.5;">Progress</div>
            <div style="font-weight:600;font-size:13px;" id="itk-progress">${state.liked} / ${config.like.maxLikes}</div>
          </div>
          <div style="background:#1a1a2e;border-radius:6px;padding:6px 8px;">
            <div style="font-size:10px;opacity:0.5;">Hourly</div>
            <div style="font-weight:600;font-size:13px;" id="itk-hourly">${state.hourlyCount} / ${safe.hourlyCap}</div>
          </div>
          <div style="background:#1a1a2e;border-radius:6px;padding:6px 8px;">
            <div style="font-size:10px;opacity:0.5;">Comments</div>
            <div style="font-weight:600;font-size:13px;" id="itk-engaged">${state.commentsLiked}</div>
          </div>
        </div>

        <div style="width:100%;height:4px;background:#1a1a2e;border-radius:2px;margin:10px 0;overflow:hidden;">
          <div id="itk-bar" style="height:100%;background:linear-gradient(90deg,#ff0050,#ff6b9d);border-radius:2px;transition:width 0.3s;width:${(state.liked / config.like.maxLikes) * 100}%;"></div>
        </div>

        <div id="itk-log" style="font-size:11px;padding:6px 8px;border-radius:4px;background:#1a1a2e;min-height:18px;word-break:break-word;color:#aaa;line-height:1.4;">
          Ready
        </div>

        <div style="font-size:10px;opacity:0.4;margin-top:6px;text-align:center;">
          Feed → Enter to start | Enter again to stop
        </div>

        <details style="margin-top:8px;">
          <summary style="cursor:pointer;font-size:11px;opacity:0.5;padding:4px 0;">⚙️ Settings</summary>
          <div style="margin-top:6px;">
            <label style="font-size:10px;opacity:0.6;">Max likes:</label>
            <input type="number" id="itk-cfg-max" value="${config.like.maxLikes}" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;margin:2px 0;">
            <label style="font-size:10px;opacity:0.6;">Hourly limit:</label>
            <input type="number" id="itk-cfg-hourly" value="${config.like.hourlyLimit}" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;margin:2px 0;">
            <label style="font-size:10px;opacity:0.6;">Max comments/post:</label>
            <input type="number" id="itk-cfg-comments" value="${config.like.maxCommentsPerPost}" style="width:100%;padding:3px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;background:#1a1a2e;color:#e0e0e0;font-size:11px;margin:2px 0;">
          </div>
          <div style="font-size:9px;opacity:0.3;margin-top:6px;text-align:center;">
            🧠 Learned: ${limits.learnedHourlyCap}/hr, ${limits.learnedPerPostCap}/post | ${limits.totalSessions} sessions
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

    function switchMode(newMode) {
      if (running) return;
      mode = newMode;
      const isLike = newMode === 'like';

      likeTab.style.background = isLike ? '#ff0050' : 'transparent';
      likeTab.style.color = isLike ? 'white' : '#888';
      unfollowTab.style.background = !isLike ? '#ff0050' : 'transparent';
      unfollowTab.style.color = !isLike ? 'white' : '#888';

      const footer = panel.querySelector('div[style*="font-size:10px;opacity:0.4;margin-top:6px;"]');
      if (footer) {
        footer.textContent = isLike ? 'Feed → Enter' : 'Following list → Enter';
      }
    }

    unfollowTab.addEventListener('click', () => switchMode('unfollow'));
    likeTab.addEventListener('click', () => switchMode('like'));

    // Settings
    function applySettings() {
      const maxInput = document.getElementById('itk-cfg-max');
      const hourlyInput = document.getElementById('itk-cfg-hourly');
      const commentsInput = document.getElementById('itk-cfg-comments');
      if (maxInput) config.like.maxLikes = parseInt(maxInput.value) || DEFAULTS.like.maxLikes;
      if (hourlyInput) config.like.hourlyLimit = parseInt(hourlyInput.value) || DEFAULTS.like.hourlyLimit;
      if (commentsInput) config.like.maxCommentsPerPost = parseInt(commentsInput.value) || DEFAULTS.like.maxCommentsPerPost;
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

      const statusEl = document.getElementById('itk-status');
      const logArea = document.getElementById('itk-log');

      if (!running) {
        stopped = false;
        running = true;
        state.emptyRounds = 0;
        state.consecutiveErrors = 0;

        sessionStorage.setItem('instatakker_state', JSON.stringify({
          liked: state.liked,
          unfollowed: state.unfollowed,
          commentsLiked: state.commentsLiked,
          postsEngaged: state.postsEngaged,
          hourlyCount: state.hourlyCount,
        }));

        log(`Started in ${mode} mode`);
        if (statusEl) {
          statusEl.textContent = `▶ Running (${mode})`;
          statusEl.style.background = '#00ff8822';
          statusEl.style.border = '1px solid #00ff8844';
        }

        if (mode === 'unfollow') {
          await instatakkerEngineUnfollow();
        } else {
          await instatakkerEngine();
        }
        running = false;
      } else {
        stopped = true;
        running = false;
        log('Stopped');
        if (statusEl) {
          statusEl.textContent = `■ Stopped`;
          statusEl.style.background = '';
          statusEl.style.border = '';
        }
      }
    }
  });

  // ======================== UNFOLLOW ENGINE ========================

  async function instatakkerEngineUnfollow() {
    const logArea = document.getElementById('itk-log');
    const statusEl = document.getElementById('itk-status');

    while (running && !stopped) {
      if (Date.now() - state.hourlyReset > 3600000) {
        state.hourlyCount = 0;
        state.hourlyReset = Date.now();
        if (logArea) logArea.textContent = '⏰ Hourly reset';
      }

      if (state.hourlyCount >= config.unfollow.hourlyLimit) {
        const waitMin = Math.ceil((3600000 - (Date.now() - state.hourlyReset)) / 60000);
        if (logArea) logArea.textContent = `⏳ Waiting ${waitMin}min`;
        await sleep(300000);
        continue;
      }

      if (state.unfollowed >= config.unfollow.maxUnfollows) {
        if (logArea) logArea.textContent = `✅ Done: ${state.unfollowed}`;
        break;
      }

      if (!document.querySelector('div[role="dialog"]')) {
        if (logArea) logArea.textContent = '⚠️ Open Following list first';
        await sleep(3000);
        continue;
      }

      const buttons = getFollowingButtons();
      if (buttons.length === 0) {
        state.emptyRounds++;
        if (state.emptyRounds >= config.unfollow.emptyRoundsBeforeStop) {
          if (logArea) logArea.textContent = `🏁 Done (${state.unfollowed})`;
          break;
        }
        await sleep(2000);
        scrollFollowingList();
        continue;
      }

      state.emptyRounds = 0;
      const btn = buttons[0];
      if (!document.contains(btn)) continue;
      if ((btn.innerText || '').trim() !== 'Following') continue;

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
          document.contains(b) && b.innerText.trim() === 'Following'
        );
        if (!stillThere) {
          state.unfollowed++;
          state.hourlyCount++;
          updateUI();
          if (statusEl) statusEl.textContent = `✅${state.unfollowed}`;
          await sleep(humanDelay(config.unfollow.minDelay, config.unfollow.maxDelay));
        } else {
          if (logArea) logArea.textContent = '⚠️ Cooling 30s...';
          await sleep(30000);
        }
      }

      scrollFollowingList();
      await sleep(config.unfollow.scrollWait);
    }

    running = false;
    if (logArea) logArea.textContent = `■ Stopped (${state.unfollowed} unfollowed)`;
    if (statusEl) { statusEl.textContent = `■`; statusEl.style.background = ''; }
  }

  // ======================== INIT ========================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel);
  } else {
    createPanel();
  }

  console.log(`%c⏹ Instatakker v${VERSION} loaded`, 'color: #ff0050; font-size: 14px; font-weight: bold;');

})();