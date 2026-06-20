/**
 * Disney+ Hotstar platform adapter.
 */
(function registerHotstarAdapter() {
  'use strict';

  window.WatchSyncAdapters = window.WatchSyncAdapters || {};

  window.WatchSyncAdapters.hotstar = {
    id: 'hotstar',
    label: 'Disney+ Hotstar',

    matches(hostname) {
      return /(^|\.)hotstar\.com$/.test(hostname);
    },

    getVideo() {
      try {
        const videos = [...document.querySelectorAll('video')].filter((v) => {
          if (v.id === 'ad-bumper-video') return false;
          try {
            const rect = v.getBoundingClientRect();
            if (rect.width < 80 || rect.height < 80) return false;
            const style = getComputedStyle(v);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            if (parseFloat(style.opacity || '1') < 0.1) return false;
          } catch {
            return false;
          }
          return v.readyState > 0 || v.currentSrc || v.src;
        });
        if (videos.length === 0) return null;
        // Prefer the actively playing element with the highest position — Hotstar
        // often mounts a fresh <video> at t=0 alongside the real player.
        return videos.sort((a, b) => {
          const aScore =
            (a.paused ? 0 : 1000) + a.currentTime + a.clientWidth * a.clientHeight * 0.001;
          const bScore =
            (b.paused ? 0 : 1000) + b.currentTime + b.clientWidth * b.clientHeight * 0.001;
          return bScore - aScore;
        })[0];
      } catch (error) {
        console.warn('[WatchSync][hotstar] getVideo failed:', error);
        return null;
      }
    },

    getTitle() {
      try {
        const selectors = [
          '.primary-title',
          '.title-wrapper .title',
          '[data-testid="player-title"]',
        ];
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const text = node?.textContent?.trim();
          if (text) return text;
        }
        return (document.title || 'Hotstar')
          .replace(/\s*[-|]\s*(Disney\+ )?Hotstar.*$/i, '')
          .trim();
      } catch (error) {
        console.warn('[WatchSync][hotstar] getTitle failed:', error);
        return 'Disney+ Hotstar';
      }
    },

    /**
     * Hotstar's SPA reloads/restarts the player when the URL hash changes and
     * when its fixed player container is resized. Disable both for this platform.
     */
    supportsAdSync: false,
    skipHashStamp: true,
    supportsPlayerSqueeze: false,

    isAd() {
      try {
        const adVideo = document.querySelector('#ad-bumper-video');
        if (!adVideo || adVideo.paused || !adVideo.currentSrc) return false;
        const rect = adVideo.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 80) return false;
        const style = getComputedStyle(adVideo);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity || '1') < 0.1) return false;
        return adVideo.currentTime > 0;
      } catch {
        return false;
      }
    },

    /** Stable key identifying the current title (numeric id from the URL). */
    getContentKey() {
      try {
        const match = location.pathname.match(/\/(\d{6,})/);
        return match ? `hotstar:${match[1]}` : `hotstar:${location.pathname}`;
      } catch {
        return 'hotstar';
      }
    },
  };
})();
