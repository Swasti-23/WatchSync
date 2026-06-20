/**
 * YouTube platform adapter.
 */
(function registerYouTubeAdapter() {
  'use strict';

  window.WatchSyncAdapters = window.WatchSyncAdapters || {};

  window.WatchSyncAdapters.youtube = {
    id: 'youtube',
    label: 'YouTube',

    matches(hostname) {
      return /(^|\.)youtube\.com$/.test(hostname);
    },

    getVideo() {
      try {
        // The main watch player lives inside #movie_player.
        const scoped = document.querySelector(
          '#movie_player video.html5-main-video, .html5-video-container video'
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
        console.warn('[WatchSync][youtube] getVideo failed:', error);
        return null;
      }
    },

    getTitle() {
      try {
        const selectors = [
          'h1.ytd-watch-metadata #video-title',
          'h1.title yt-formatted-string',
          '.ytp-title-link',
        ];
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const text = node?.textContent?.trim();
          if (text) return text;
        }
        return (document.title || 'YouTube')
          .replace(/\s*[-|]\s*YouTube.*$/i, '')
          .replace(/^\(\d+\)\s*/, '')
          .trim();
      } catch (error) {
        console.warn('[WatchSync][youtube] getTitle failed:', error);
        return 'YouTube';
      }
    },

    /**
     * Reliable ad detection: YouTube adds `ad-showing`/`ad-interrupting` to the
     * player element while an ad is on screen.
     */
    isAd() {
      try {
        const player =
          document.querySelector('#movie_player') ||
          document.querySelector('.html5-video-player');
        return !!(
          player &&
          (player.classList.contains('ad-showing') ||
            player.classList.contains('ad-interrupting'))
        );
      } catch {
        return false;
      }
    },

    /** Stable key identifying the current video (the `v` id). */
    getContentKey() {
      try {
        const url = new URL(location.href);
        const v = url.searchParams.get('v');
        if (v) return `youtube:${v}`;
        const match = location.pathname.match(/\/(?:shorts|embed|live)\/([\w-]+)/);
        return match ? `youtube:${match[1]}` : `youtube:${location.pathname}`;
      } catch {
        return 'youtube';
      }
    },
  };
})();
