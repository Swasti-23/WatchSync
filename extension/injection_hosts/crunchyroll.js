/**
 * Crunchyroll platform adapter.
 *
 * Crunchyroll renders its player inside a same-origin iframe
 * (static.crunchyroll.com / vilos player). Because the content script runs on
 * the top frame only (`all_frames: false`), we first look for a video in the
 * top document, then transparently reach into the player iframe when it is
 * same-origin and accessible.
 */
(function registerCrunchyrollAdapter() {
  'use strict';

  window.WatchSyncAdapters = window.WatchSyncAdapters || {};

  function findInFrames() {
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const frame of iframes) {
        try {
          const doc = frame.contentDocument;
          if (!doc) continue;
          const video = doc.querySelector('video');
          if (video) return video;
        } catch {
          // Cross-origin frame — not accessible, skip silently.
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  window.WatchSyncAdapters.crunchyroll = {
    id: 'crunchyroll',
    label: 'Crunchyroll',

    matches(hostname) {
      return /(^|\.)crunchyroll\.com$/.test(hostname);
    },

    getVideo() {
      try {
        const direct = document.querySelector('#player0 video, .vilosPlayer video, video');
        if (direct) return direct;
        return findInFrames();
      } catch (error) {
        console.warn('[WatchSync][crunchyroll] getVideo failed:', error);
        return null;
      }
    },

    getTitle() {
      try {
        const selectors = [
          '.title .episode-title',
          'h1.title',
          '.erc-current-media-info h1',
          'h4.title',
        ];
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const text = node?.textContent?.trim();
          if (text) return text;
        }
        return (document.title || 'Crunchyroll')
          .replace(/\s*[-|]\s*Crunchyroll.*$/i, '')
          .trim();
      } catch (error) {
        console.warn('[WatchSync][crunchyroll] getTitle failed:', error);
        return 'Crunchyroll';
      }
    },

    /** Best-effort detection of a Crunchyroll ad break. */
    isAd() {
      try {
        if (document.querySelector('.ad-container, [class*="ad-overlay"], [class*="AdBreak"]')) {
          return true;
        }
        const video = this.getVideo();
        return !!(video && /(\/ads?\/|ad_break|adsystem)/i.test(video.currentSrc || ''));
      } catch {
        return false;
      }
    },

    /** Stable key identifying the current episode (id from /watch/<id>). */
    getContentKey() {
      try {
        const match = location.pathname.match(/\/watch\/([A-Za-z0-9]+)/);
        return match ? `crunchyroll:${match[1]}` : `crunchyroll:${location.pathname}`;
      } catch {
        return 'crunchyroll';
      }
    },
  };
})();
