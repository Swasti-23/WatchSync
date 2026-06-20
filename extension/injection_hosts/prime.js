/**
 * Amazon Prime Video platform adapter.
 * Handles both primevideo.com and the amazon.com /gp/video player surface.
 */
(function registerPrimeAdapter() {
  'use strict';

  window.WatchSyncAdapters = window.WatchSyncAdapters || {};

  window.WatchSyncAdapters.prime = {
    id: 'prime',
    label: 'Prime Video',

    matches(hostname) {
      return (
        /(^|\.)primevideo\.com$/.test(hostname) ||
        /(^|\.)amazon\.[a-z.]+$/.test(hostname)
      );
    },

    getVideo() {
      try {
        // Prime hosts the player inside a .webPlayerContainer; fall back to any
        // sufficiently large video element.
        const scoped = document.querySelector(
          '.webPlayerContainer video, .dv-player-fullscreen video'
        );
        if (scoped) return scoped;

        const videos = [...document.querySelectorAll('video')].filter(
          (v) => v.readyState > 0 || v.currentSrc || v.src
        );
        if (videos.length === 0) return null;
        return videos.sort(
          (a, b) =>
            b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight
        )[0];
      } catch (error) {
        console.warn('[WatchSync][prime] getVideo failed:', error);
        return null;
      }
    },

    getTitle() {
      try {
        const selectors = [
          '.atvwebplayersdk-title-text',
          '.title h1',
          '[data-automation-id="title"]',
        ];
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const text = node?.textContent?.trim();
          if (text) return text;
        }
        return (document.title || 'Prime Video')
          .replace(/\s*[-|]\s*Prime Video.*$/i, '')
          .replace(/\s*[-|]\s*Amazon.*$/i, '')
          .trim();
      } catch (error) {
        console.warn('[WatchSync][prime] getTitle failed:', error);
        return 'Prime Video';
      }
    },

    /** Best-effort detection of a Prime ad break. */
    isAd() {
      try {
        const scope =
          document.querySelector('.webPlayerContainer, .dv-player-fullscreen') ||
          document;
        return !!scope.querySelector(
          '.atvwebplayersdk-adtimeindicator-text, [class*="adCountdown"], ' +
            '[class*="ad-countdown"], .adBadge, [data-testid*="ad-"], [class*="AdBreak"]'
        );
      } catch {
        return false;
      }
    },

    /** Stable key identifying the current title (gti/asin from the URL). */
    getContentKey() {
      try {
        const url = new URL(location.href);
        const gti =
          url.searchParams.get('gti') ||
          url.searchParams.get('asin') ||
          url.searchParams.get('titleId');
        if (gti) return `prime:${gti}`;
        const match = location.pathname.match(/\/(?:detail|watch)\/([A-Za-z0-9]+)/);
        return match ? `prime:${match[1]}` : `prime:${location.pathname}`;
      } catch {
        return 'prime';
      }
    },
  };
})();
