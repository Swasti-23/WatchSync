/**
 * Netflix platform adapter.
 * --------------------------------------------------------------------------
 * Every adapter registers itself into the shared `window.WatchSyncAdapters`
 * registry. Because all files listed in a single `content_scripts` entry share
 * the same isolated execution world, this registry is visible to `content.js`.
 *
 * An adapter is a thin, defensive abstraction over a platform's HTML5 <video>
 * element. It must never throw: each accessor is wrapped so that a DOM change
 * on the streaming site degrades gracefully instead of crashing the sync loop.
 */
(function registerNetflixAdapter() {
  'use strict';

  window.WatchSyncAdapters = window.WatchSyncAdapters || {};

  window.WatchSyncAdapters.netflix = {
    id: 'netflix',
    label: 'Netflix',

    /** Whether this adapter handles the given hostname. */
    matches(hostname) {
      return /(^|\.)netflix\.com$/.test(hostname);
    },

    /**
     * Locate the active, playable <video> element. Netflix renders the player
     * inside a watch route; we pick the largest video to avoid trailers/previews.
     */
    getVideo() {
      try {
        const videos = [...document.querySelectorAll('video')].filter(
          (v) => v.readyState > 0 || v.currentSrc || v.src
        );
        if (videos.length === 0) return null;
        // Prefer the video with the largest visible area (the main player).
        return videos.sort(
          (a, b) =>
            b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight
        )[0];
      } catch (error) {
        console.warn('[WatchSync][netflix] getVideo failed:', error);
        return null;
      }
    },

    /** Best-effort title extraction from Netflix's player DOM. */
    getTitle() {
      try {
        const selectors = [
          '[data-uia="video-title"] h4',
          '[data-uia="video-title"]',
          '.video-title h4',
          '.ellipsize-text h4',
          '.title-text',
        ];
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const text = node?.textContent?.trim();
          if (text) return text;
        }
        return (document.title || 'Netflix').replace(/\s*[-|]\s*Netflix.*$/i, '').trim();
      } catch (error) {
        console.warn('[WatchSync][netflix] getTitle failed:', error);
        return 'Netflix';
      }
    },

    /** Best-effort detection of an ad break (Netflix ad-supported tier). */
    isAd() {
      try {
        return !!document.querySelector(
          '[data-uia*="ad-"], [class*="AdBreak"], [class*="ad-timer"], .ad-progress'
        );
      } catch {
        return false;
      }
    },

    /** Stable key identifying the current title, used to sync episode changes. */
    getContentKey() {
      try {
        const match = location.pathname.match(/\/watch\/(\d+)/);
        return match ? `netflix:${match[1]}` : `netflix:${location.pathname}`;
      } catch {
        return 'netflix';
      }
    },
  };
})();
