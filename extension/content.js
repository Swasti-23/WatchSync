/**
 * WatchSync — content script
 * --------------------------------------------------------------------------
 * Injected into every supported streaming page. Responsibilities:
 *   1. Pick the correct PlatformAdapter for the current host.
 *   2. Bind to the page's HTML5 <video> element (now or whenever it appears,
 *      via MutationObserver) and mirror local Play/Pause/Seek actions to peers.
 *   3. Apply remote actions to the local video while suppressing the resulting
 *      "echo" events with a synchronization guard (no infinite loops).
 *   4. Render an isolated, Shadow-DOM chat sidebar with ephemeral profiles,
 *      live chat and auto-generated system notifications.
 *   5. Manage the WebSocket connection (with auto-reconnect) to the relay.
 *
 * The script is wrapped in an IIFE so it never leaks globals into the page,
 * and guards against double-injection on SPA navigations.
 * --------------------------------------------------------------------------
 */
(function WatchSyncMain() {
  'use strict';

  if (window.__WATCHSYNC_LOADED__) return;
  window.__WATCHSYNC_LOADED__ = true;

  /* ---------------------------------------------------------------------- */
  /* Constants & configuration                                              */
  /* ---------------------------------------------------------------------- */

  const DEFAULT_SERVER_URL = 'ws://localhost:8080';
  const HASH_KEY = 'wsRoom'; // location.hash carrier for the room id.
  const SEEK_THRESHOLD_SECONDS = 0.75; // Ignore seeks smaller than this.
  const REMOTE_GUARD_MS = 800; // How long to suppress echo events.
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 15000;
  const PANEL_WIDTH = 340; // Sidebar width in px; used to squeeze the player.
  const MIN_SQUEEZE_WIDTH = 1000; // Don't squeeze the player on small screens.
  const MESSAGE_GROUP_GAP_MS = 5 * 60 * 1000; // Re-show sender after this gap (WhatsApp-style).
  const JOIN_GRACE_MS = 4000; // Suppress our own playback events right after joining.
  const ROOM_STORAGE_KEY = '__watchsync_room__'; // sessionStorage fallback for the room id.
  const NAME_STORAGE_KEY = '__watchsync_name__';
  const AVATAR_STORAGE_KEY = '__watchsync_avatar__';
  const AD_POLL_MS = 700; // How often to check ad / navigation state.
  const FRAME_MSG = '__WATCHSYNC_FRAME__'; // postMessage tag for cross-frame bridging.
  const CATCHUP_DELAYS_MS = [300, 900, 1800, 3500, 6000]; // Retry catch-up for late-mounting players.
  const IS_TOP_FRAME = (() => {
    try {
      return window.top === window.self;
    } catch {
      return false; // Cross-origin access throws => we are in a sub-frame.
    }
  })();

  const GUEST_ADJECTIVES = ['Swift', 'Cosmic', 'Neon', 'Lunar', 'Turbo', 'Pixel'];

  /** Teleparty-style quick reactions (bar + floating overlay). */
  const REACTIONS = [
    { id: 'happy', emoji: '😄', label: 'Happy' },
    { id: 'laugh', emoji: '😂', label: 'Laughing' },
    { id: 'angry', emoji: '😠', label: 'Angry' },
    { id: 'shocked', emoji: '🤯', label: 'Shocked' },
    { id: 'celebrate', emoji: '🎉', label: 'Celebrate' },
  ];
  const REACTION_BY_ID = Object.fromEntries(REACTIONS.map((r) => [r.id, r]));

  // Some platforms (Crunchyroll) host the <video> inside a same-domain iframe.
  // The full app (UI + WebSocket) only runs in the top frame; sub-frames run a
  // tiny bridge that relays their video's events to/from the top frame.
  if (!IS_TOP_FRAME) {
    initFrameBridge();
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* Small utilities                                                        */
  /* ---------------------------------------------------------------------- */

  /** Format wall-clock time for chat bubbles (e.g. "3:42 PM"). */
  function formatMessageTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  /** Format a number of seconds as MM:SS (or H:MM:SS when >= 1 hour). */
  function formatTime(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
    const seconds = Math.floor(totalSeconds % 60);
    const minutes = Math.floor((totalSeconds / 60) % 60);
    const hours = Math.floor(totalSeconds / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0
      ? `${hours}:${pad(minutes)}:${pad(seconds)}`
      : `${pad(minutes)}:${pad(seconds)}`;
  }

  /** Generate a friendly random ephemeral guest name, e.g. "Guest 402". */
  function randomGuestName() {
    const adj = GUEST_ADJECTIVES[Math.floor(Math.random() * GUEST_ADJECTIVES.length)];
    const num = Math.floor(100 + Math.random() * 900);
    return `${adj} Guest ${num}`;
  }

  /** Read the room id from the current URL hash, if present. */
  function getRoomFromHash() {
    try {
      const hash = (location.hash || '').replace(/^#/, '');
      const params = new URLSearchParams(hash);
      const room = params.get(HASH_KEY);
      if (room && room.trim()) return room.trim();
    } catch {
      /* fall through to the sessionStorage fallback */
    }
    // Single-page apps (notably Hotstar) sometimes strip the URL fragment after
    // load. capture.js stashes the room id in sessionStorage at document_start,
    // so we can still recover it here even once the hash is gone.
    try {
      const stored = sessionStorage.getItem(ROOM_STORAGE_KEY);
      return stored ? stored.trim() : null;
    } catch {
      return null;
    }
  }

  /** Write the room id into the URL hash (and a per-tab sessionStorage backup). */
  function setRoomInHash(roomId, adapter) {
    try {
      sessionStorage.setItem(ROOM_STORAGE_KEY, roomId);
    } catch {
      /* sessionStorage may be unavailable */
    }
    // Hotstar restarts the player when the hash changes — keep the room id in
    // sessionStorage only and leave the page URL untouched.
    if (adapter?.skipHashStamp) return;
    try {
      const hash = (location.hash || '').replace(/^#/, '');
      const params = new URLSearchParams(hash);
      params.set(HASH_KEY, roomId);
      const newHash = `#${params.toString()}`;
      history.replaceState(null, '', `${location.pathname}${location.search}${newHash}`);
    } catch (error) {
      console.warn('[WatchSync] Could not update URL hash:', error);
    }
  }

  /** Forget any stored room id (called when the user explicitly leaves). */
  function clearStoredRoom() {
    try {
      sessionStorage.removeItem(ROOM_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  /** Load a previously chosen guest name for this browser profile. */
  function loadStoredName() {
    try {
      const stored = sessionStorage.getItem(NAME_STORAGE_KEY);
      if (stored && stored.trim()) return stored.trim();
    } catch {
      /* ignore */
    }
    return null;
  }

  /** Load a previously picked avatar for this tab / browser profile. */
  function loadStoredAvatar() {
    try {
      const stored = sessionStorage.getItem(AVATAR_STORAGE_KEY);
      if (stored && window.WatchSyncAvatars?.ids?.includes(stored)) return stored;
    } catch {
      /* ignore */
    }
    return null;
  }

  /** Remember name + avatar across new parties (session + extension storage). */
  function saveProfile({ name, avatar }) {
    try {
      if (name) sessionStorage.setItem(NAME_STORAGE_KEY, name);
      if (avatar) sessionStorage.setItem(AVATAR_STORAGE_KEY, avatar);
    } catch {
      /* ignore */
    }
    try {
      const patch = {};
      if (name) patch.profileName = name;
      if (avatar) patch.profileAvatar = avatar;
      if (Object.keys(patch).length) chrome.storage?.local?.set(patch);
    } catch {
      /* ignore */
    }
  }

  /** Build a shareable link for the current page + room. */
  function buildShareLink(roomId) {
    const url = new URL(location.href);
    const hash = (url.hash || '').replace(/^#/, '');
    const params = new URLSearchParams(hash);
    params.set(HASH_KEY, roomId);
    url.hash = params.toString();
    return url.toString();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text == null ? '' : text);
    return div.innerHTML;
  }

  /** Pick a stable cartoon avatar for a sender name (fallback when none sent). */
  function resolveAvatarId(sender, avatarId) {
    if (avatarId && window.WatchSyncAvatars?.ids?.includes(avatarId)) return avatarId;
    const ids = window.WatchSyncAvatars?.ids || ['cat'];
    const str = String(sender || 'guest');
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash + str.charCodeAt(i) * 17) % 9973;
    return ids[hash % ids.length];
  }

  /** True while this content-script instance can still talk to the extension. */
  function isExtensionContextValid() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  /** One-time banner when the extension was reloaded but the tab was not. */
  function showReloadBanner() {
    if (document.getElementById('watchsync-reload-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'watchsync-reload-banner';
    bar.textContent = 'WatchSync was updated — please reload this tab to reconnect.';
    bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:2147483646;background:#e74c3c;' +
      'color:#fff;text-align:center;padding:10px 14px;font:600 13px -apple-system,sans-serif;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.35);';
    (document.documentElement || document.body).appendChild(bar);
  }

  /* Embedded sidebar CSS — used when styles.css cannot be fetched (e.g. after an
     extension reload invalidates chrome.runtime on an already-open tab). */
  const EMBEDDED_SIDEBAR_CSS = `:host{all:initial;position:fixed;top:0;right:0;width:340px;height:100vh;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#eef0ff;pointer-events:none}.ws-panel{pointer-events:auto;display:flex;flex-direction:column;height:100%;position:relative;overflow:hidden;background:#12131f;border-left:1px solid #2c2f4a;box-shadow:-8px 0 32px rgba(0,0,0,.45);transition:transform .25s ease}.ws-panel.ws-hidden{transform:translateX(100%)}.ws-launcher{pointer-events:auto;position:fixed;top:14px;right:14px;width:46px;height:46px;border:none;border-radius:50%;cursor:pointer;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:#fff;font-size:20px;line-height:1;display:none;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.45)}.ws-launcher.ws-show{display:inline-flex}.ws-launcher.ws-has-unread::after{content:"";position:absolute;top:2px;right:2px;width:10px;height:10px;border-radius:50%;background:#e74c3c;border:2px solid #5340d6;box-sizing:border-box}.ws-header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:linear-gradient(135deg,#6c5ce7,#5340d6)}.ws-brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px}.ws-dot{width:9px;height:9px;border-radius:50%;background:#b9b3ff}.ws-dot[data-state=online]{background:#2ecc71}.ws-dot[data-state=connecting]{background:#f1c40f}.ws-dot[data-state=offline]{background:#e74c3c}.ws-icon-btn{width:26px;height:26px;border:none;border-radius:6px;background:rgba(255,255,255,.15);color:#fff;cursor:pointer}.ws-room{padding:10px 14px;background:#181a2c;border-bottom:1px solid #2c2f4a}.ws-room-row{display:flex;justify-content:space-between;margin-bottom:8px}.ws-status-text{font-size:12px;color:#9aa0c0}.ws-members{font-size:12px;font-weight:600;color:#a29bfe}.ws-share{display:flex;gap:6px}.ws-share-input{flex:1;min-width:0;padding:7px 9px;border-radius:8px;border:1px solid #2c2f4a;background:#21243d;color:#cfd3f0;font-size:11px}.ws-messages{list-style:none;margin:0;padding:12px 14px;flex:1 1 auto;overflow-y:auto;display:flex;flex-direction:column;gap:2px;background:#12131f}.ws-msg{font-size:13px;line-height:1.4;word-break:break-word}.ws-msg-user{display:flex;flex-direction:row;align-items:flex-end;gap:8px;align-self:flex-start;max-width:92%;margin-top:6px}.ws-msg-user.ws-msg-continued{margin-top:1px}.ws-msg-avatar{width:28px;height:28px;border-radius:50%;overflow:hidden;flex:0 0 28px;background:#21243d;border:1.5px solid #5340d6}.ws-msg-avatar-spacer{visibility:hidden;border-color:transparent;background:transparent}.ws-msg-avatar svg{width:100%;height:100%;display:block}.ws-msg-body{background:#1d2036;padding:6px 10px 5px;border-radius:10px;min-width:0;flex:1}.ws-msg-sender{display:block;font-size:11px;font-weight:700;color:#a29bfe;margin-bottom:3px}.ws-msg-content{display:flex;flex-wrap:wrap;align-items:flex-end;gap:4px 8px}.ws-msg-text{color:#eef0ff;flex:1 1 auto;min-width:0}.ws-msg-time{font-size:10px;color:#9aa0c0;line-height:1.2;flex:0 0 auto;white-space:nowrap;margin-left:auto}.ws-unread-divider{display:flex;align-items:center;gap:10px;margin:14px 0 10px;list-style:none;color:#a29bfe;font-size:11px;font-weight:600}.ws-unread-divider::before,.ws-unread-divider::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,transparent,#5340d6,transparent)}.ws-msg-system{align-self:center;text-align:center;margin-top:8px;margin-bottom:4px}.ws-msg-system-text{display:inline-block;font-size:11.5px;color:#ffd479;background:rgba(255,212,121,.08);padding:4px 10px;border-radius:999px}.ws-footer{padding:10px 14px 14px;background:#181a2c;border-top:1px solid #2c2f4a}.ws-input{flex:1;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid #2c2f4a;background:#21243d;color:#eef0ff;font-size:13px}.ws-compose{display:flex;gap:6px}.ws-btn{padding:9px 14px;border:none;border-radius:10px;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:#fff;font-weight:600;font-size:13px;cursor:pointer}.ws-btn-sm{padding:7px 10px;font-size:11px}.ws-body{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}.ws-main-view,.ws-settings-view{flex:1;display:flex;flex-direction:column;min-height:0}.ws-hidden{display:none!important}.ws-settings-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #2c2f4a}.ws-back-btn{width:30px;height:30px;border:none;border-radius:8px;background:#21243d;color:#eef0ff;cursor:pointer}.ws-profile-card{padding:20px 14px;display:flex;flex-direction:column;align-items:center;gap:14px}.ws-avatar-display{width:92px;height:92px;border-radius:50%;overflow:hidden;border:3px solid #6c5ce7;background:#21243d}.ws-avatar-display svg{width:100%;height:100%}.ws-profile-name{font-size:17px;font-weight:700}.ws-pencil-btn{width:28px;height:28px;border:none;border-radius:8px;background:#21243d;color:#a29bfe;cursor:pointer}.ws-name-edit-row{display:flex;gap:8px;width:100%}.ws-name-edit-input{flex:1;padding:8px 10px;border-radius:8px;border:1px solid #2c2f4a;background:#21243d;color:#eef0ff}.ws-avatar-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:0 14px 14px}.ws-avatar-option{border:2px solid transparent;border-radius:14px;padding:6px;background:#1d2036;cursor:pointer}.ws-avatar-option.ws-selected{border-color:#a29bfe}.ws-emoji-popover{position:absolute;left:14px;right:14px;bottom:112px;z-index:10;border-radius:12px;overflow:hidden;border:1px solid #2c2f4a;box-shadow:0 -8px 28px rgba(0,0,0,.45);background:#21243d}.ws-emoji-picker-host{height:300px}.ws-ep{display:flex;flex-direction:column;height:100%}.ws-ep-tabs{display:flex;gap:4px;padding:8px;overflow-x:auto;border-bottom:1px solid #2c2f4a}.ws-ep-tab{width:32px;height:32px;border:none;border-radius:8px;background:transparent;font-size:18px;cursor:pointer;flex:0 0 32px}.ws-ep-tab.ws-ep-tab-active{background:rgba(108,92,231,.25)}.ws-ep-grid{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(8,1fr);gap:2px;padding:8px}.ws-ep-item{border:none;background:transparent;font-size:22px;cursor:pointer;border-radius:6px;padding:4px 0}.ws-ep-item:hover{background:rgba(255,255,255,.08)}.ws-reaction-bar{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 2px 8px;border-bottom:1px solid rgba(44,47,74,.65);margin-bottom:8px}.ws-reaction-btn{flex:1;min-width:0;height:36px;border:none;border-radius:10px;background:rgba(255,255,255,.04);font-size:22px;cursor:pointer}.ws-reaction-btn:hover{background:rgba(108,92,231,.22);transform:scale(1.08)}.ws-compose{display:flex;align-items:center;gap:6px}.ws-input{border-radius:22px}.ws-icon-action{width:36px;height:36px;padding:0;border:none;border-radius:50%;background:transparent;color:#9aa0c0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:0 0 36px}.ws-icon-action.ws-active{color:#a29bfe;background:rgba(108,92,231,.18)}.ws-send-btn{width:36px;height:36px;padding:0;border:none;border-radius:50%;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:0 0 36px}.ws-send-btn:disabled{opacity:.45;cursor:not-allowed}`;

  /* ---------------------------------------------------------------------- */
  /* PlayerController — robust abstraction over the platform's <video>      */
  /* ---------------------------------------------------------------------- */

  class PlayerController {
    /**
     * @param {object} adapter   The selected platform adapter.
     * @param {(action:string, time:number)=>void} onLocalAction
     *        Invoked when the *local* user performs play/pause/seek.
     */
    constructor(adapter, onLocalAction) {
      this.adapter = adapter;
      this.onLocalAction = onLocalAction;
      this.video = null;

      // Synchronization guard: while > 0 (a timestamp in the future), locally
      // fired media events are treated as echoes of a remote command and
      // ignored. This is the core defense against infinite sync loops.
      this.suppressUntil = 0;

      // While true, any local "play" is immediately undone. Used when a new
      // joiner loads a page whose player autoplays before catch-up arrives.
      this.holdPausedUntilSync = false;

      this._boundHandlers = {
        play: () => this._handleLocalEvent('play'),
        pause: () => this._handleLocalEvent('pause'),
        seeked: () => this._handleLocalEvent('seek'),
      };

      // State mirrored from a sub-frame player (e.g. Crunchyroll's iframe) when
      // there is no <video> in the top frame.
      this._bridge = { active: false, time: 0, paused: true, isAd: false };

      this._observer = null;
      this._startObserving();
      this._initBridgeListener();
      this.attach(); // Try immediately (video may already exist).
    }

    /** True when we have to drive playback through a sub-frame bridge. */
    get usingBridge() {
      return !this.video && this._bridge.active;
    }

    /** Receive playback events bubbled up from a sub-frame player. */
    _initBridgeListener() {
      this._bridgeHandler = (event) => {
        const data = event.data;
        if (!data || data.source !== FRAME_MSG || data.dir !== 'up') return;
        this._bridge.active = true;
        if (typeof data.time === 'number') this._bridge.time = data.time;
        if (typeof data.paused === 'boolean') this._bridge.paused = data.paused;
        this._bridge.isAd = !!data.isAd;
        if (data.action === 'state') return; // Heartbeat only.
        if (this.isApplyingRemote) return; // Ignore our own command echoes.
        try {
          this.onLocalAction(data.action, data.time);
        } catch (error) {
          console.warn('[WatchSync] bridge onLocalAction failed:', error);
        }
      };
      window.addEventListener('message', this._bridgeHandler);
    }

    /** Send a playback command down to every sub-frame. */
    _sendToFrames(action, time) {
      try {
        for (const frame of document.querySelectorAll('iframe')) {
          try {
            frame.contentWindow?.postMessage(
              { source: FRAME_MSG, dir: 'down', action, time },
              '*'
            );
          } catch {
            /* cross-origin frame we can't post to from here; ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }

    /** Is an ad currently playing (local video or bridged sub-frame)? */
    isAd() {
      try {
        if (this.usingBridge) return !!this._bridge.isAd;
        return !!this.adapter.isAd?.();
      } catch {
        return false;
      }
    }

    /** True while we are programmatically applying a remote command. */
    get isApplyingRemote() {
      return Date.now() < this.suppressUntil;
    }

    /** Temporarily suppress locally fired media events. */
    _guard() {
      this.suppressUntil = Date.now() + REMOTE_GUARD_MS;
    }

    /** Keep the player paused until the group sends us its real state. */
    setHoldPaused(active) {
      this.holdPausedUntilSync = !!active;
      if (active) this._enforceHoldPaused();
    }

    /** Force-pause if we are waiting for initial group sync. */
    _enforceHoldPaused() {
      if (!this.holdPausedUntilSync || this.isApplyingRemote) return;
      this.attach();
      if (!this.video && !this._bridge.active) return;
      try {
        if (this.adapter.isAd?.()) return;
        if (!this.isPaused()) {
          this._guard();
          if (this.video) this.video.pause();
          else this._sendToFrames('pause', this._bridge.time || 0);
        }
      } catch {
        /* ignore */
      }
    }

    /** Watch the DOM for a (re)appearing video element on SPA navigations. */
    _startObserving() {
      try {
        this._observer = new MutationObserver(() => {
          const current = this.adapter.getVideo();
          if (current && current !== this.video) this.attach();
        });
        this._observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      } catch (error) {
        console.warn('[WatchSync] MutationObserver failed:', error);
      }
    }

    /** Bind media event listeners to the current video element. */
    attach() {
      let video = null;
      try {
        video = this.adapter.getVideo();
      } catch (error) {
        console.warn('[WatchSync] adapter.getVideo threw:', error);
      }
      if (!video || video === this.video) return;

      // Hotstar mounts replacement <video> elements at t=0 while the real player
      // is still on the previous element — don't swap down to the empty one.
      if (this.video && this.video.isConnected && this.video.currentTime > 2) {
        const nextTime = video.currentTime || 0;
        if (nextTime < 1) return;
      }

      this.detach();
      this.video = video;

      try {
        video.addEventListener('play', this._boundHandlers.play);
        video.addEventListener('pause', this._boundHandlers.pause);
        video.addEventListener('seeked', this._boundHandlers.seeked);
      } catch (error) {
        console.warn('[WatchSync] Failed to attach video listeners:', error);
      }

      if (this.holdPausedUntilSync) {
        setTimeout(() => this._enforceHoldPaused(), 0);
        setTimeout(() => this._enforceHoldPaused(), 250);
      }
    }

    /** Remove listeners from the previously bound video element. */
    detach() {
      if (!this.video) return;
      try {
        this.video.removeEventListener('play', this._boundHandlers.play);
        this.video.removeEventListener('pause', this._boundHandlers.pause);
        this.video.removeEventListener('seeked', this._boundHandlers.seeked);
      } catch {
        /* ignore */
      }
    }

    _handleLocalEvent(action) {
      // Drop echoes produced by our own remote-apply calls.
      if (this.isApplyingRemote) return;

      // New joiner: block autoplay until we receive the group's state.
      if (this.holdPausedUntilSync) {
        if (action === 'play') this._enforceHoldPaused();
        return;
      }

      if (!this.video) return;
      const time = this.getCurrentTime();
      try {
        this.onLocalAction(action, time);
      } catch (error) {
        console.warn('[WatchSync] onLocalAction handler failed:', error);
      }
    }

    getCurrentTime() {
      try {
        if (this.video) return this.video.currentTime || 0;
        if (this._bridge.active) return this._bridge.time || 0;
        return 0;
      } catch {
        return 0;
      }
    }

    /** Best-effort paused state across local video and bridge. */
    isPaused() {
      try {
        if (this.video) return this.video.paused;
        if (this._bridge.active) return this._bridge.paused;
      } catch {
        /* ignore */
      }
      return true;
    }

    getTitle() {
      try {
        return this.adapter.getTitle() || document.title;
      } catch {
        return document.title;
      }
    }

    /**
     * Apply a remote action to the local video, suppressing the resulting
     * echo events so they are not re-broadcast.
     */
    applyRemote(action, time) {
      this.attach();

      // No local video but a sub-frame is driving playback: relay the command.
      if (!this.video && this._bridge.active) {
        this._guard();
        this._sendToFrames(action, typeof time === 'number' ? time : this._bridge.time);
        return;
      }

      if (!this.video) return;
      this._guard();

      try {
        if (typeof time === 'number' && Number.isFinite(time)) {
          const drift = Math.abs(this.video.currentTime - time);
          // Only seek on explicit seeks, or before resuming playback — a remote
          // pause should not yank Hotstar's player back to the start.
          if (action === 'seek' || (action === 'play' && drift > SEEK_THRESHOLD_SECONDS)) {
            this.video.currentTime = time;
          }
        }

        if (action === 'play' && this.video.paused) {
          const playResult = this.video.play();
          if (playResult && typeof playResult.catch === 'function') {
            playResult.catch(() => {
              /* Autoplay policies may block; user can click play manually. */
            });
          }
        } else if (action === 'pause' && !this.video.paused) {
          this.video.pause();
        }
      } catch (error) {
        console.warn('[WatchSync] applyRemote failed:', error);
      }
    }

    destroy() {
      this.detach();
      if (this._observer) {
        try {
          this._observer.disconnect();
        } catch {
          /* ignore */
        }
      }
      if (this._bridgeHandler) {
        try {
          window.removeEventListener('message', this._bridgeHandler);
        } catch {
          /* ignore */
        }
        this._bridgeHandler = null;
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* ReactionLayer — floating emoji overlays on the video page               */
  /* ---------------------------------------------------------------------- */

  class ReactionLayer {
    constructor() {
      this._ensureStyles();
      let layer = document.getElementById('watchsync-reaction-layer');
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'watchsync-reaction-layer';
        layer.setAttribute('aria-hidden', 'true');
        (document.documentElement || document.body).appendChild(layer);
      }
      this.layer = layer;
    }

    _ensureStyles() {
      if (document.getElementById('watchsync-reaction-style')) return;
      const style = document.createElement('style');
      style.id = 'watchsync-reaction-style';
      style.textContent =
        '#watchsync-reaction-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483646;overflow:hidden}' +
        '.ws-float-reaction{position:absolute;bottom:-10vh;transform:translateX(-50%);font-size:52px;line-height:1;' +
        'animation:wsReactionFloat 3s ease-out forwards;filter:drop-shadow(0 6px 16px rgba(0,0,0,.55));' +
        'will-change:transform,opacity;user-select:none}' +
        '@keyframes wsReactionFloat{0%{transform:translateX(-50%) translateY(0) scale(.5);opacity:0}' +
        '12%{opacity:1;transform:translateX(-50%) translateY(-8vh) scale(1.15)}' +
        '25%{transform:translateX(-50%) translateY(-18vh) scale(1)}' +
        '75%{opacity:1}' +
        '100%{transform:translateX(-50%) translateY(-92vh) scale(.95);opacity:0}}';
      (document.head || document.documentElement).appendChild(style);
    }

    spawn(emoji) {
      if (!this.layer || !emoji) return;
      const el = document.createElement('div');
      el.className = 'ws-float-reaction';
      el.textContent = emoji;
      el.style.left = `${10 + Math.random() * 80}%`;
      el.style.animationDuration = `${2.6 + Math.random() * 0.9}s`;
      el.style.fontSize = `${44 + Math.random() * 20}px`;
      this.layer.appendChild(el);
      const cleanup = () => el.remove();
      el.addEventListener('animationend', cleanup, { once: true });
      setTimeout(cleanup, 4500);
    }

    destroy() {
      try {
        this.layer?.replaceChildren();
        this.layer?.remove();
        this.layer = null;
      } catch {
        /* ignore */
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* ChatSidebar — isolated Shadow DOM UI                                   */
  /* ---------------------------------------------------------------------- */

  class ChatSidebar {
    /**
     * @param {object} callbacks
     *   onSendMessage(text), onRenameSelf(name), onAvatarChange(id), onReaction(id), onClose()
     */
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.hostEl = null;
      this.shadow = null;
      this.refs = {};
      this.collapsed = false;
      this.settingsOpen = false;
      this.avatarPickerOpen = false;
      this.emojiPickerOpen = false;
      this._emojiPickerReady = false;

      // The DOM is built asynchronously (we fetch styles.css). Until it is
      // ready, setter calls are buffered here and flushed once the refs exist.
      // This is what fixes the "share link never appears" race.
      this.ready = false;
      this._pending = { messages: [] };
      this.messageLog = [];
      this.lastReadIndex = 0;
      this.unreadCount = 0;
      this._lastUserBlock = null;
      this._unreadDividerEl = null;
      this._msgSeq = 0;
      this._keyGuard = null;
      this._squeezed = null; // { el, original inline styles } while squeezing.
      this._squeezeTimer = null;
      this._onResize = null;

      this._build();
    }

    async _build() {
      // Host element lives directly under <html> so site CSS can't reach it.
      this.hostEl = document.createElement('div');
      this.hostEl.id = 'watchsync-root';
      // Note: isolation is handled by the Shadow DOM + the `:host { all: initial }`
      // rule in styles.css (which then re-applies position/size). We must NOT set
      // an inline `all: initial` here, as inline styles would override `:host`.
      this.shadow = this.hostEl.attachShadow({ mode: 'open' });

      // Load isolated styles from the packaged stylesheet.
      const style = document.createElement('style');
      style.textContent = await this._loadStyles();
      this.shadow.appendChild(style);

      const panel = document.createElement('div');
      panel.className = 'ws-panel';
      panel.innerHTML = this._template();
      this.shadow.appendChild(panel);

      // Floating launcher button — the only way back when the panel is hidden.
      const launcher = document.createElement('button');
      launcher.className = 'ws-launcher';
      launcher.title = 'Open WatchSync chat';
      launcher.textContent = '⚡';
      launcher.addEventListener('click', () => this.toggleCollapse());
      this.shadow.appendChild(launcher);

      (document.documentElement || document.body).appendChild(this.hostEl);
      this._injectHostPageStyle();
      this._installKeyGuard();
      document.documentElement.classList.add('watchsync-active');

      this._cacheRefs();
      this.refs.launcher = launcher;
      this._buildAvatarGrid();
      this._buildReactionBar();
      this._wireEvents();

      // The UI is now interactive: flush any state set before the build finished.
      this.ready = true;
      this._flushPending();

      // Squeeze the player so the sidebar doesn't overlap it. The player often
      // mounts after us, so retry for a while and on every window resize.
      this._onResize = () => {
        if (!this.collapsed) this.applySqueeze();
      };
      window.addEventListener('resize', this._onResize);

      let squeezeTries = 0;
      this._squeezeTimer = setInterval(() => {
        if (!this.collapsed) this.applySqueeze();
        if (++squeezeTries > 12) {
          clearInterval(this._squeezeTimer);
          this._squeezeTimer = null;
        }
      }, 1000);
      this.applySqueeze();
    }

    /**
     * Prevent the host streaming site's global keyboard shortcuts from firing
     * while the user is interacting with our sidebar.
     *
     * Events fired inside the Shadow DOM are "composed": they propagate out to
     * the page, where players like Hotstar/YouTube treat keys such as `l`/`k`/
     * `f`/space as seek/play/fullscreen commands. We register a capture-phase
     * listener on `window` (the very first node in the capture path) and, if the
     * event originated from our sidebar, stop it before any site handler sees it.
     */
    _installKeyGuard() {
      this._keyGuard = (event) => {
        try {
          const path = event.composedPath ? event.composedPath() : [];
          if (path.includes(this.hostEl)) {
            event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
          }
        } catch {
          /* ignore */
        }
      };
      for (const type of ['keydown', 'keyup', 'keypress']) {
        window.addEventListener(type, this._keyGuard, true);
      }
    }

    /** Apply any setter values / messages that were buffered before build. */
    _flushPending() {
      const p = this._pending;
      if (p.selfName != null) this.setSelfName(p.selfName);
      if (p.selfAvatar != null) this.setSelfAvatar(p.selfAvatar);
      if (p.shareLink != null) this.setShareLink(p.shareLink);
      if (p.status) this.setStatus(p.status.text, p.status.state);
      if (p.memberCount != null) this.setMemberCount(p.memberCount);
      for (const item of p.messages) {
        this.addMessage(item.msg, { notify: item.notify });
      }
      this._pending = { messages: [] };
    }

    /**
     * Inject a tiny stylesheet into the *host* page that nudges its layout left
     * to make room for the sidebar. This lives outside the Shadow DOM (the
     * shadow CSS cannot reach the host page). It is best-effort: fullscreen,
     * fixed-position players simply ignore the margin and we overlay cleanly.
     */
    _injectHostPageStyle() {
      if (document.getElementById('watchsync-host-style')) return;
      const style = document.createElement('style');
      style.id = 'watchsync-host-style';
      style.textContent =
        'html.watchsync-active body{transition:margin-right .25s ease;}' +
        '@media (min-width:1100px){html.watchsync-active body{margin-right:340px!important;}}';
      (document.head || document.documentElement).appendChild(style);
    }

    async _loadStyles() {
      if (!isExtensionContextValid()) return EMBEDDED_SIDEBAR_CSS;
      try {
        const url = chrome.runtime.getURL('styles.css');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch {
        return EMBEDDED_SIDEBAR_CSS;
      }
    }

    _template() {
      return `
        <header class="ws-header">
          <div class="ws-brand">
            <span class="ws-dot" data-ref="statusDot"></span>
            <span class="ws-title">WatchSync</span>
          </div>
          <div class="ws-header-actions">
            <button class="ws-icon-btn" data-ref="settingsBtn" title="Profile settings" aria-label="Profile settings">
              <svg class="ws-gear-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path fill="currentColor" d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97 0-.33-.03-.66-.07-1l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.05 7.05 0 0 0-1.73-1l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65a7.05 7.05 0 0 0-1.73 1l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64L4.57 11c-.04.34-.07.67-.07 1 0 .33.03.65.07.97l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.48 1.1.87 1.73 1.16l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .5-.42l.38-2.65c.63-.29 1.21-.68 1.73-1.16l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65z"/>
              </svg>
            </button>
            <button class="ws-icon-btn" data-ref="collapseBtn" title="Collapse">—</button>
            <button class="ws-icon-btn" data-ref="closeBtn" title="Leave party">✕</button>
          </div>
        </header>

        <div class="ws-emoji-popover ws-hidden" data-ref="emojiPopover">
          <div class="ws-emoji-picker-host" data-ref="emojiPickerHost"></div>
        </div>

        <div class="ws-body">
          <div class="ws-main-view" data-ref="mainView">
            <section class="ws-room">
              <div class="ws-room-row">
                <span class="ws-status-text" data-ref="statusText">Connecting…</span>
                <span class="ws-members" data-ref="memberCount">0 watching</span>
              </div>
              <div class="ws-share">
                <input class="ws-share-input" data-ref="shareInput" readonly />
                <button class="ws-btn ws-btn-sm" data-ref="copyBtn">Copy link</button>
              </div>
            </section>

            <ul class="ws-messages" data-ref="messages"></ul>

            <footer class="ws-footer">
              <div class="ws-reaction-bar" data-ref="reactionBar" role="toolbar" aria-label="Quick reactions"></div>
              <form class="ws-compose" data-ref="composeForm">
                <input class="ws-input" data-ref="msgInput" placeholder="Type a message…" maxlength="500" autocomplete="off" />
                <button class="ws-icon-action ws-emoji-btn" type="button" data-ref="emojiBtn" title="Emoji" aria-label="Emoji">
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                    <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5-9c.83 0 1.5-.67 1.5-1.5S7.83 8 7 8s-1.5.67-1.5 1.5S6.17 11 7 11zm10 0c.83 0 1.5-.67 1.5-1.5S17.83 8 17 8s-1.5.67-1.5 1.5.67 1.5 1.5 1.5zm-5 5.5c2.33 0 4.32-1.45 5.12-3.5H6.88c.8 2.05 2.79 3.5 5.12 3.5z"/>
                  </svg>
                </button>
                <button class="ws-send-btn" type="submit" title="Send" aria-label="Send">
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </button>
              </form>
            </footer>
          </div>

          <div class="ws-settings-view ws-hidden" data-ref="settingsView">
            <div class="ws-settings-head">
              <button class="ws-back-btn" data-ref="settingsBackBtn" title="Back to chat" aria-label="Back">←</button>
              <span class="ws-settings-title">Profile</span>
            </div>

            <div class="ws-profile-card">
              <button class="ws-avatar-btn" data-ref="avatarBtn" title="Change avatar" aria-label="Change avatar">
                <span class="ws-avatar-display" data-ref="avatarDisplay"></span>
                <span class="ws-avatar-hint">Tap to change</span>
              </button>

              <div class="ws-name-row" data-ref="nameDisplayRow">
                <span class="ws-profile-name" data-ref="profileNameDisplay">Guest</span>
                <button class="ws-pencil-btn" data-ref="editNameBtn" title="Edit name" aria-label="Edit name">
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                    <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                  </svg>
                </button>
              </div>

              <div class="ws-name-edit-row ws-hidden" data-ref="nameEditRow">
                <input class="ws-name-edit-input" data-ref="nameEditInput" maxlength="24" placeholder="Your name" />
                <button class="ws-btn ws-btn-sm" data-ref="saveNameBtn">Save</button>
              </div>
            </div>

            <div class="ws-avatar-picker ws-hidden" data-ref="avatarPicker">
              <p class="ws-picker-label">Choose your avatar</p>
              <div class="ws-avatar-grid" data-ref="avatarGrid"></div>
            </div>
          </div>
        </div>
      `;
    }

    _cacheRefs() {
      this.shadow.querySelectorAll('[data-ref]').forEach((el) => {
        this.refs[el.getAttribute('data-ref')] = el;
      });
    }

    _buildReactionBar() {
      if (!this.refs.reactionBar) return;
      this.refs.reactionBar.replaceChildren();
      for (const reaction of REACTIONS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ws-reaction-btn';
        btn.dataset.reaction = reaction.id;
        btn.title = reaction.label;
        btn.setAttribute('aria-label', reaction.label);
        btn.textContent = reaction.emoji;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.callbacks.onReaction?.(reaction.id);
        });
        this.refs.reactionBar.appendChild(btn);
      }
    }

    _wireEvents() {
      this.refs.composeForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this._submitMessage();
      });

      this.refs.msgInput.addEventListener('input', () => this._updateSendButtonState());
      this.refs.msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this._submitMessage();
        }
      });

      this.refs.emojiBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleEmojiPicker();
      });

      this._outsideEmojiClose = (e) => {
        if (!this.emojiPickerOpen) return;
        const path = e.composedPath ? e.composedPath() : [];
        if (path.includes(this.refs.emojiPopover) || path.includes(this.refs.emojiBtn)) return;
        this._toggleEmojiPicker(false);
      };
      this.shadow.addEventListener('click', this._outsideEmojiClose);

      this.refs.copyBtn.addEventListener('click', () => {
        const link = this.refs.shareInput.value;
        if (!link) return;
        const flash = () => {
          this.refs.copyBtn.textContent = 'Copied!';
          setTimeout(() => (this.refs.copyBtn.textContent = 'Copy link'), 1500);
        };
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(link).then(flash, () => {
            if (this._fallbackCopy(link)) flash();
          });
        } else if (this._fallbackCopy(link)) {
          flash();
        }
      });

      this.refs.settingsBtn.addEventListener('click', () => this.toggleSettings(true));
      this.refs.settingsBackBtn.addEventListener('click', () => this.toggleSettings(false));
      this.refs.collapseBtn.addEventListener('click', () => this.toggleCollapse());
      this.refs.closeBtn.addEventListener('click', () => this.callbacks.onClose());

      this.refs.editNameBtn.addEventListener('click', () => this._startNameEdit());
      this.refs.saveNameBtn.addEventListener('click', () => this._commitNameEdit());
      this.refs.nameEditInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._commitNameEdit();
        }
        if (e.key === 'Escape') this._cancelNameEdit();
      });

      this.refs.avatarBtn.addEventListener('click', () => this._toggleAvatarPicker());

      this._updateSendButtonState();
    }

    _submitMessage() {
      const text = this.refs.msgInput?.value.trim();
      if (!text) return;
      this.refs.msgInput.value = '';
      this._updateSendButtonState();
      this._toggleEmojiPicker(false);
      this.callbacks.onSendMessage(text);
    }

    _updateSendButtonState() {
      const hasText = !!this.refs.msgInput?.value.trim();
      if (this.refs.composeForm) {
        const sendBtn = this.refs.composeForm.querySelector('.ws-send-btn');
        if (sendBtn) sendBtn.disabled = !hasText;
      }
    }

    _insertEmojiAtCursor(emoji) {
      const input = this.refs.msgInput;
      if (!input || !emoji) return;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      const next = input.value.slice(0, start) + emoji + input.value.slice(end);
      if (next.length > (input.maxLength || 500)) return;
      input.value = next;
      const pos = start + emoji.length;
      input.setSelectionRange(pos, pos);
      input.focus();
      this._updateSendButtonState();
    }

    _loadEmojiPicker() {
      if (this._emojiPickerReady || !this.refs.emojiPickerHost) return;
      if (!window.WatchSyncEmojiPanel?.mount) {
        console.warn('[WatchSync] Emoji panel script not loaded.');
        return;
      }
      try {
        window.WatchSyncEmojiPanel.mount(this.refs.emojiPickerHost, {
          onPick: (emoji) => this._insertEmojiAtCursor(emoji),
        });
        this._emojiPickerReady = true;
      } catch (error) {
        console.warn('[WatchSync] Emoji picker failed to load:', error);
      }
    }

    _toggleEmojiPicker(show) {
      const next = typeof show === 'boolean' ? show : !this.emojiPickerOpen;
      this.emojiPickerOpen = next;
      if (this.refs.emojiPopover) {
        this.refs.emojiPopover.classList.toggle('ws-hidden', !next);
      }
      this.refs.emojiBtn?.classList.toggle('ws-active', next);
      if (next) this._loadEmojiPicker();
    }

    toggleSettings(open) {
      this.settingsOpen = open;
      this.refs.mainView?.classList.toggle('ws-hidden', open);
      this.refs.settingsView?.classList.toggle('ws-hidden', !open);
      if (!open) {
        this._toggleAvatarPicker(false);
        this._toggleEmojiPicker(false);
        this._cancelNameEdit();
      }
    }

    _startNameEdit() {
      if (!this.refs.nameEditInput || !this.refs.profileNameDisplay) return;
      this.refs.nameEditInput.value = this.refs.profileNameDisplay.textContent.trim();
      this.refs.nameDisplayRow?.classList.add('ws-hidden');
      this.refs.nameEditRow?.classList.remove('ws-hidden');
      this.refs.nameEditInput.focus();
      this.refs.nameEditInput.select();
    }

    _cancelNameEdit() {
      this.refs.nameDisplayRow?.classList.remove('ws-hidden');
      this.refs.nameEditRow?.classList.add('ws-hidden');
    }

    _commitNameEdit() {
      const name = this.refs.nameEditInput?.value.trim();
      if (name) {
        this.callbacks.onRenameSelf(name);
        if (this.refs.profileNameDisplay) this.refs.profileNameDisplay.textContent = name;
      }
      this._cancelNameEdit();
    }

    _toggleAvatarPicker(show) {
      const next = typeof show === 'boolean' ? show : !this.avatarPickerOpen;
      this.avatarPickerOpen = next;
      this.refs.avatarPicker?.classList.toggle('ws-hidden', !next);
    }

    _buildAvatarGrid() {
      if (!this.refs.avatarGrid) return;
      const registry = window.WatchSyncAvatars;
      const ids = registry?.ids || ['cat'];
      this.refs.avatarGrid.innerHTML = ids
        .map(
          (id) =>
            `<button class="ws-avatar-option" data-avatar-id="${id}" title="${id}" aria-label="${id} avatar">` +
            `${registry.getSvg(id)}</button>`
        )
        .join('');

      this.refs.avatarGrid.querySelectorAll('.ws-avatar-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-avatar-id');
          if (id) {
            this.setSelfAvatar(id);
            this.callbacks.onAvatarChange?.(id);
            this._toggleAvatarPicker(false);
          }
        });
      });
    }

    _renderAvatarInto(el, avatarId) {
      if (!el) return;
      const svg = window.WatchSyncAvatars?.getSvg(avatarId) || '';
      el.innerHTML = svg;
    }

    /** Last-resort clipboard copy via a temporary textarea in the page. */
    _fallbackCopy(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }

    toggleCollapse() {
      const wasCollapsed = this.collapsed;
      this.collapsed = !this.collapsed;
      const panel = this.shadow.querySelector('.ws-panel');
      panel.classList.toggle('ws-hidden', this.collapsed);
      this.refs.launcher?.classList.toggle('ws-show', this.collapsed);
      document.documentElement.classList.toggle('watchsync-active', !this.collapsed);
      if (this.collapsed) {
        this.lastReadIndex = this.messageLog.length;
        this._removeUnreadDivider();
        this._toggleEmojiPicker(false);
        this.removeSqueeze();
      } else {
        this.applySqueeze();
        if (wasCollapsed) {
          this._insertUnreadDivider();
          this._clearUnreadIndicator();
          this.lastReadIndex = this.messageLog.length;
        }
      }
    }

    /**
     * Find the streaming player's full-viewport container by walking up from the
     * <video> element. Sites like Hotstar use a fixed/absolute container that
     * ignores `body { margin }`, so we resize this element directly.
     */
    _findPlayerContainer() {
      let video = null;
      try {
        video = this.callbacks.getVideo?.();
      } catch {
        video = null;
      }
      if (!video) return null;

      let el = video.parentElement;
      let chosen = null;
      while (el && el !== document.documentElement) {
        try {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (
            (style.position === 'fixed' || style.position === 'absolute') &&
            rect.width >= window.innerWidth * 0.9 &&
            rect.height >= window.innerHeight * 0.85
          ) {
            chosen = el; // Keep climbing; prefer the outermost full-size wrapper.
          }
        } catch {
          /* ignore */
        }
        el = el.parentElement;
      }
      return chosen;
    }

    /** Shrink the player so it sits to the left of the sidebar (no overlap). */
    applySqueeze() {
      if (this.collapsed) return;
      if (this.callbacks.skipPlayerSqueeze) return;
      if (window.innerWidth < MIN_SQUEEZE_WIDTH) return;
      // Already squeezing a still-attached container — nothing to do.
      if (this._squeezed && document.contains(this._squeezed.el)) return;

      const el = this._findPlayerContainer();
      if (!el) return;

      this.removeSqueeze();
      this._squeezed = {
        el,
        width: el.style.getPropertyValue('width'),
        widthPriority: el.style.getPropertyPriority('width'),
        right: el.style.getPropertyValue('right'),
        rightPriority: el.style.getPropertyPriority('right'),
        left: el.style.getPropertyValue('left'),
        leftPriority: el.style.getPropertyPriority('left'),
      };
      el.style.setProperty('width', `calc(100vw - ${PANEL_WIDTH}px)`, 'important');
      el.style.setProperty('right', 'auto', 'important');
      el.style.setProperty('left', '0', 'important');

      // Nudge the player to recompute its internal layout/controls.
      try {
        window.dispatchEvent(new Event('resize'));
      } catch {
        /* ignore */
      }
    }

    /** Restore the player container's original inline styles. */
    removeSqueeze() {
      const s = this._squeezed;
      if (!s) return;
      try {
        const restore = (prop, value, priority) => {
          if (value) s.el.style.setProperty(prop, value, priority);
          else s.el.style.removeProperty(prop);
        };
        restore('width', s.width, s.widthPriority);
        restore('right', s.right, s.rightPriority);
        restore('left', s.left, s.leftPriority);
        window.dispatchEvent(new Event('resize'));
      } catch {
        /* ignore */
      }
      this._squeezed = null;
    }

    setSelfName(name) {
      if (!this.ready) {
        this._pending.selfName = name;
        return;
      }
      if (this.refs.profileNameDisplay) this.refs.profileNameDisplay.textContent = name;
    }

    setSelfAvatar(avatarId) {
      if (!this.ready) {
        this._pending.selfAvatar = avatarId;
        return;
      }
      this._currentAvatar = avatarId;
      this._renderAvatarInto(this.refs.avatarDisplay, avatarId);
      this.refs.avatarGrid
        ?.querySelectorAll('.ws-avatar-option')
        .forEach((btn) => {
          btn.classList.toggle(
            'ws-selected',
            btn.getAttribute('data-avatar-id') === avatarId
          );
        });
    }

    setShareLink(link) {
      if (!this.ready) {
        this._pending.shareLink = link;
        return;
      }
      if (this.refs.shareInput) this.refs.shareInput.value = link;
    }

    setStatus(text, state) {
      if (!this.ready) {
        this._pending.status = { text, state };
        return;
      }
      if (this.refs.statusText) this.refs.statusText.textContent = text;
      if (this.refs.statusDot) this.refs.statusDot.dataset.state = state || 'idle';
    }

    setMemberCount(count) {
      if (!this.ready) {
        this._pending.memberCount = count;
        return;
      }
      if (this.refs.memberCount) {
        this.refs.memberCount.textContent =
          count === 1 ? '1 watching' : `${count} watching`;
      }
    }

    _shouldShowSenderHeader(sender, timestamp) {
      const prev = this._lastUserBlock;
      if (!prev || prev.sender !== sender) return true;
      return timestamp - prev.timestamp > MESSAGE_GROUP_GAP_MS;
    }

    _createMessageElement(entry) {
      const { sender, text, kind, avatar, timestamp } = entry;
      const li = document.createElement('li');
      li.className = `ws-msg ws-msg-${kind || 'user'}`;
      li.dataset.msgId = String(entry.id);

      if (kind === 'system') {
        this._lastUserBlock = null;
        li.className = 'ws-msg ws-msg-system';
        li.innerHTML = `<span class="ws-msg-system-text">${escapeHtml(text)}</span>`;
        return li;
      }

      const showHeader = this._shouldShowSenderHeader(sender, timestamp);
      if (showHeader) {
        li.classList.add('ws-msg-new-block');
      } else {
        li.classList.add('ws-msg-continued');
      }
      this._lastUserBlock = { sender, timestamp };

      const av = resolveAvatarId(sender, avatar);
      const avatarHtml = showHeader
        ? `<span class="ws-msg-avatar" aria-hidden="true">${window.WatchSyncAvatars?.getSvg(av) || ''}</span>`
        : `<span class="ws-msg-avatar ws-msg-avatar-spacer" aria-hidden="true"></span>`;

      const senderHtml = showHeader
        ? `<span class="ws-msg-sender">${escapeHtml(sender)}</span>`
        : '';

      li.innerHTML =
        avatarHtml +
        `<div class="ws-msg-body">` +
        senderHtml +
        `<div class="ws-msg-content">` +
        `<span class="ws-msg-text">${escapeHtml(text)}</span>` +
        `<span class="ws-msg-time">${escapeHtml(formatMessageTime(timestamp))}</span>` +
        `</div></div>`;
      return li;
    }

    _isNearBottom() {
      if (!this.refs.messages) return true;
      return (
        this.refs.messages.scrollHeight - this.refs.messages.scrollTop -
          this.refs.messages.clientHeight < 60
      );
    }

    _scrollMessagesToBottom() {
      if (!this.refs.messages) return;
      this.refs.messages.scrollTop = this.refs.messages.scrollHeight;
    }

    _incrementUnread() {
      this.unreadCount += 1;
      this._syncExtensionBadge();
      this.refs.launcher?.classList.add('ws-has-unread');
    }

    _clearUnreadIndicator() {
      this.unreadCount = 0;
      this._syncExtensionBadge();
      this.refs.launcher?.classList.remove('ws-has-unread');
    }

    _syncExtensionBadge() {
      if (!isExtensionContextValid()) return;
      try {
        chrome.runtime.sendMessage({
          type: 'WS_SET_BADGE',
          count: this.unreadCount,
        });
      } catch {
        /* ignore */
      }
    }

    _insertUnreadDivider() {
      this._removeUnreadDivider();
      if (this.lastReadIndex >= this.messageLog.length) return;

      const firstUnread = this.messageLog[this.lastReadIndex];
      if (!firstUnread?.el) return;

      const unreadCount = this.messageLog.length - this.lastReadIndex;
      const divider = document.createElement('li');
      divider.className = 'ws-unread-divider';
      divider.setAttribute('role', 'separator');
      divider.innerHTML = `<span>${unreadCount} unread message${unreadCount === 1 ? '' : 's'}</span>`;
      this.refs.messages.insertBefore(divider, firstUnread.el);
      this._unreadDividerEl = divider;

      requestAnimationFrame(() => {
        divider.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }

    _removeUnreadDivider() {
      this._unreadDividerEl?.remove();
      this._unreadDividerEl = null;
    }

    addMessage(msg, options = {}) {
      const notify = !!options.notify;
      const timestamp = msg.timestamp ?? Date.now();
      const entry = {
        sender: msg.sender,
        text: msg.text,
        kind: msg.kind || 'user',
        avatar: msg.avatar,
        timestamp,
        id: ++this._msgSeq,
        el: null,
      };

      if (!this.ready) {
        this._pending.messages.push({ msg: entry, notify });
        return;
      }

      if (!this.refs.messages) return;

      const atBottom = this._isNearBottom();
      const li = this._createMessageElement(entry);
      entry.el = li;
      this.messageLog.push(entry);
      this.refs.messages.appendChild(li);

      if (options.dismissUnread) {
        this._removeUnreadDivider();
      }

      if (this.collapsed && notify) {
        this._incrementUnread();
      } else if (!this.collapsed) {
        this.lastReadIndex = this.messageLog.length;
        if (atBottom) this._scrollMessagesToBottom();
      }
    }

    destroy() {
      try {
        if (this._outsideEmojiClose) {
          this.shadow.removeEventListener('click', this._outsideEmojiClose);
          this._outsideEmojiClose = null;
        }
        this._clearUnreadIndicator();
        this.removeSqueeze();
        if (this._squeezeTimer) {
          clearInterval(this._squeezeTimer);
          this._squeezeTimer = null;
        }
        if (this._onResize) {
          window.removeEventListener('resize', this._onResize);
          this._onResize = null;
        }
        if (this._keyGuard) {
          for (const type of ['keydown', 'keyup', 'keypress']) {
            window.removeEventListener(type, this._keyGuard, true);
          }
          this._keyGuard = null;
        }
        document.documentElement.classList.remove('watchsync-active');
        document.getElementById('watchsync-host-style')?.remove();
        this.hostEl?.remove();
      } catch {
        /* ignore */
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* WatchSyncApp — orchestrates connection, player and UI                  */
  /* ---------------------------------------------------------------------- */

  class WatchSyncApp {
    constructor(adapter) {
      this.adapter = adapter;
      this.serverUrl = DEFAULT_SERVER_URL;

      this.roomId = null;
      this.selfName = loadStoredName() || randomGuestName();
      this.selfAvatar = loadStoredAvatar() || window.WatchSyncAvatars?.random?.() || 'cat';
      this.members = new Map(); // clientId -> name
      this.peerAvatars = new Map(); // sender name -> avatar id
      this.isHost = false;

      this.socket = null;
      this.reconnectAttempts = 0;
      this.reconnectTimer = null;
      this.manualClose = false;
      this.pendingJoinType = null; // 'ROOM_CREATE' | 'ROOM_JOIN'

      // While in the future, our own playback events are NOT broadcast. This
      // covers the moment right after joining, when a freshly loaded player
      // (e.g. YouTube) fires play/seek at time 0 — without this, a new joiner
      // would reset everyone else's video back to the start.
      this.suppressOutgoingUntil = 0;

      // Ad coordination.
      this.localIsAd = false; // Are WE currently in an ad break?
      this.remoteAdClients = new Set(); // Peers currently in ad breaks.
      this.adPaused = false; // Did WE pause our content to wait for a peer's ad?
      this.groupPlaying = false; // Intended (non-ad) group play state.
      this._pendingAdState = null; // Debounce flaky ad detection.
      this._adStableCount = 0;

      // Navigation (episode change) sync.
      this.lastContentKey = null;

      // New joiners adopt the group's state instead of autoplaying.
      this.awaitingInitialSync = false;
      this.initialSyncTimer = null;

      this.monitorTimer = null;

      this.player = new PlayerController(adapter, (action, time) =>
        this.handleLocalPlayback(action, time)
      );

      this.ui = new ChatSidebar({
        onSendMessage: (text) => this.sendChat(text),
        onRenameSelf: (name) => this.renameSelf(name),
        onAvatarChange: (id) => this.changeAvatar(id),
        onReaction: (id) => this.sendReaction(id),
        onClose: () => this.leave(),
        getVideo: () => this.player.video || this.adapter.getVideo(),
        skipPlayerSqueeze: adapter.supportsPlayerSqueeze === false,
      });
      this.reactionLayer = new ReactionLayer();
      this.ui.setSelfName(this.selfName);
      this.ui.setSelfAvatar(this.selfAvatar);
    }

    /* ----- session bootstrap ----- */

    async start({ roomId, create }) {
      if (this.roomId && this.roomId === roomId) return;

      await this._hydrateProfile();

      // Resolve the server URL from storage (popup may override the default).
      try {
        const stored = await chrome.storage?.local?.get('serverUrl');
        if (stored?.serverUrl) this.serverUrl = stored.serverUrl;
      } catch {
        /* storage may be unavailable; default is fine */
      }

      this.roomId = roomId || (self.crypto?.randomUUID?.() ?? `${Date.now()}`);
      this.isHost = !!create;
      this.pendingJoinType = create ? 'ROOM_CREATE' : 'ROOM_JOIN';

      // Only suppress outgoing events for joiners loading a fresh player. The
      // host is already watching — blocking their events breaks Hotstar sync.
      if (create) {
        this.suppressOutgoingUntil = 0;
        this.groupPlaying = !this.player.isPaused();
      } else {
        this.suppressOutgoingUntil = Date.now() + JOIN_GRACE_MS;
      }

      try {
        this.lastContentKey = this.adapter.getContentKey?.() || location.href;
      } catch {
        this.lastContentKey = location.href;
      }

      setRoomInHash(this.roomId, this.adapter);
      this.ui.setShareLink(buildShareLink(this.roomId));

      // Joiners should adopt the existing group state rather than autoplaying.
      if (!create) {
        this.player.setHoldPaused(true);
        const t = this.player.getCurrentTime();
        this.player.applyRemote('pause', t > 0 ? t : undefined);
        this._beginAwaitingInitialSync();
      }

      this._startMonitors();
      this.connect();
    }

    /** Restore the last chosen name/avatar from extension storage if needed. */
    async _hydrateProfile() {
      try {
        const stored = await chrome.storage?.local?.get(['profileName', 'profileAvatar']);
        const name =
          loadStoredName() ||
          (typeof stored?.profileName === 'string' ? stored.profileName.trim() : '');
        const avatar =
          loadStoredAvatar() ||
          (typeof stored?.profileAvatar === 'string' ? stored.profileAvatar : '');

        if (name) {
          this.selfName = name;
          this.ui.setSelfName(name);
          saveProfile({ name });
        }
        if (avatar && window.WatchSyncAvatars?.ids?.includes(avatar)) {
          this.selfAvatar = avatar;
          this.ui.setSelfAvatar(avatar);
          saveProfile({ avatar });
        }
      } catch {
        /* storage unavailable — keep constructor defaults */
      }
    }

    /**
     * Keep a just-loaded player paused until we receive the group's real state.
     * Re-pauses aggressively because YouTube/Hotstar often autoplay after we
     * pause once. Gives up after a short window if no state ever arrives.
     */
    _beginAwaitingInitialSync() {
      this.awaitingInitialSync = true;
      const deadline = Date.now() + 12000;
      clearInterval(this.initialSyncTimer);
      this.initialSyncTimer = setInterval(() => {
        if (!this.awaitingInitialSync || Date.now() > deadline) {
          clearInterval(this.initialSyncTimer);
          this.initialSyncTimer = null;
          this.awaitingInitialSync = false;
          this.player.setHoldPaused(false);
          return;
        }
        this.player.setHoldPaused(true);
        this.player._enforceHoldPaused();
      }, 200);
    }

    /** Periodic checks for ad-state and episode (navigation) changes. */
    _startMonitors() {
      clearInterval(this.monitorTimer);
      this.monitorTimer = setInterval(() => {
        try {
          this.checkAdState();
          this.checkNavChange();
        } catch (error) {
          console.warn('[WatchSync] monitor tick failed:', error);
        }
      }, AD_POLL_MS);
    }

    /* ----- WebSocket lifecycle ----- */

    connect() {
      this.manualClose = false;
      this.ui.setStatus('Connecting…', 'connecting');
      try {
        this.socket = new WebSocket(this.serverUrl);
      } catch (error) {
        console.error('[WatchSync] WebSocket construction failed:', error);
        this.scheduleReconnect();
        return;
      }

      this.socket.addEventListener('open', () => {
        this.reconnectAttempts = 0;
        this.ui.setStatus('Connected', 'online');
        this.send(this.pendingJoinType, {
          roomId: this.roomId,
          profile: { name: this.selfName, avatar: this.selfAvatar },
        });
      });

      this.socket.addEventListener('message', (event) => this.onSocketMessage(event));

      this.socket.addEventListener('close', () => {
        this.ui.setStatus('Disconnected', 'offline');
        if (!this.manualClose) this.scheduleReconnect();
      });

      this.socket.addEventListener('error', () => {
        this.ui.setStatus('Connection error', 'offline');
      });
    }

    scheduleReconnect() {
      if (this.manualClose) return;
      clearTimeout(this.reconnectTimer);
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
        RECONNECT_MAX_MS
      );
      this.reconnectAttempts += 1;
      this.ui.setStatus(`Reconnecting in ${Math.round(delay / 1000)}s…`, 'connecting');
      // Once joined, reconnects should re-join (not re-create) the room.
      this.pendingJoinType = 'ROOM_JOIN';
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    send(type, data = {}) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      try {
        this.socket.send(JSON.stringify({ type, ...data }));
      } catch (error) {
        console.warn('[WatchSync] Failed to send over socket:', error);
      }
    }

    onSocketMessage(event) {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        console.warn('[WatchSync] Received malformed message:', error);
        return;
      }

      try {
        this.routeMessage(message);
      } catch (error) {
        console.warn('[WatchSync] Error routing message:', error, message);
      }
    }

    routeMessage(message) {
      switch (message.type) {
        case 'ROOM_STATE': {
          this.members.clear();
          (message.members || []).forEach((m) => {
            this.members.set(m.clientId, m.name);
            if (m.avatar) this.peerAvatars.set(m.name, m.avatar);
          });
          this.ui.setMemberCount(this.members.size);
          // Joiners loading a fresh player need a grace window; hosts do not.
          if (!this.isHost && this.pendingJoinType === 'ROOM_JOIN') {
            this.suppressOutgoingUntil = Date.now() + JOIN_GRACE_MS;
            this.player.setHoldPaused(true);
            const t = this.player.getCurrentTime();
            this.player.applyRemote('pause', t > 0 ? t : undefined);
          }
          this.ui.addMessage(
            {
              kind: 'system',
              text: `⚡ You joined the party as ${this.selfName}.`,
            },
            { notify: false }
          );
          break;
        }

        case 'PEER_JOINED': {
          const m = message.member;
          if (m) {
            this.members.set(m.clientId, m.name);
            if (m.avatar) this.peerAvatars.set(m.name, m.avatar);
            this.ui.setMemberCount(this.members.size);
            this.ui.addMessage(
              { kind: 'system', text: `⚡ ${m.name} joined the party.` },
              { notify: true }
            );
            // Catch the newcomer up to where we currently are so their freshly
            // loaded player jumps to the right spot instead of staying at 0.
            this.sendCatchUpState();
          }
          break;
        }

        case 'PEER_LEFT': {
          this.members.delete(message.clientId);
          this.ui.setMemberCount(this.members.size);
          // If they left mid-ad, don't keep everyone else paused for them.
          if (this.remoteAdClients.delete(message.clientId)) this.reconcileAds();
          if (message.name) {
            this.ui.addMessage(
              { kind: 'system', text: `⚡ ${message.name} left the party.` },
              { notify: true }
            );
          }
          break;
        }

        case 'USER_UPDATE': {
          const old = this.members.get(message.clientId);
          this.members.set(message.clientId, message.name);
          if (message.avatar) this.peerAvatars.set(message.name, message.avatar);
          this.ui.addMessage(
            {
              kind: 'system',
              text: `⚡ ${old || 'A guest'} is now ${message.name}.`,
            },
            { notify: false }
          );
          break;
        }

        case 'SYNC_VIDEO': {
          this.handleRemotePlaybackSync(message.payload || {});
          break;
        }

        case 'AD_STATE': {
          if (this.adapter.supportsAdSync === false) break;
          const isAd = !!(message.payload && message.payload.isAd);
          if (isAd) this.remoteAdClients.add(message.from);
          else this.remoteAdClients.delete(message.from);
          this.reconcileAds();
          break;
        }

        case 'NAV_SYNC': {
          this.handleRemoteNav(message.payload || {});
          break;
        }

        case 'CHAT_MESSAGE': {
          const p = message.payload || {};
          if (p.type !== 'system' && p.sender && p.avatar) {
            this.peerAvatars.set(p.sender, p.avatar);
          }
          this.ui.addMessage(
            {
              kind: p.type === 'system' ? 'system' : 'user',
              sender: p.sender,
              text: p.text,
              avatar: p.avatar || this.peerAvatars.get(p.sender),
            },
            { notify: p.type !== 'system' }
          );
          break;
        }

        case 'REACTION': {
          const p = message.payload || {};
          const reaction = REACTION_BY_ID[p.id];
          if (reaction) this.reactionLayer?.spawn(reaction.emoji);
          break;
        }

        case 'ERROR': {
          console.warn('[WatchSync] Server error:', message.message);
          break;
        }

        default:
          break;
      }
    }

    /* ----- playback synchronization ----- */

    /** Local user performed an action -> broadcast + emit a system message. */
    handleLocalPlayback(action, time) {
      // Don't broadcast events fired by our own ad break — those are the ad's
      // play/pause, not a real user action on the shared content.
      if (this.localIsAd) return;

      // While we're gated by a peer's ad, our content must stay paused. Swallow
      // these events (and re-pause if the player tried to auto-resume).
      if (this.adPaused) {
        if (action === 'play') {
          this.player.applyRemote('pause', this.player.getCurrentTime());
        }
        return;
      }

      // Don't leak our own startup events (e.g. autoplay from 0) to peers right
      // after we join — that is exactly what was resetting everyone to 0:00.
      if (Date.now() < this.suppressOutgoingUntil) return;

      // Track the intended (non-ad) group play state so we can restore it
      // after ad breaks finish.
      if (action === 'play') this.groupPlaying = true;
      else if (action === 'pause') this.groupPlaying = false;

      this.send('SYNC_VIDEO', { payload: { action, time, title: this.player.getTitle() } });

      const stamp = formatTime(time);
      let text = null;
      if (action === 'pause') text = `⚡ ${this.selfName} paused at ${stamp}`;
      else if (action === 'play') text = `⚡ ${this.selfName} resumed at ${stamp}`;
      else if (action === 'seek') text = `⚡ ${this.selfName} skipped to ${stamp}`;

      if (text) this.broadcastSystemMessage(text);
    }

    /** Apply a peer's action to the local player. */
    handleRemotePlaybackSync(payload) {
      const { action, time } = payload;
      if (!action) return;

      // We now know the group's real state — stop force-pausing on join.
      this.awaitingInitialSync = false;
      this.player.setHoldPaused(false);

      if (action === 'play') this.groupPlaying = true;
      else if (action === 'pause') this.groupPlaying = false;

      // If we're paused waiting on a peer's ad, remember the intent but don't
      // actually resume until their ad ends.
      if (this.adPaused && action === 'play') return;

      const hadVideo = !!(this.player.video || this.player._bridge.active);
      this.player.applyRemote(action, typeof time === 'number' ? time : undefined);

      // Only retry when the player wasn't mounted yet (common on join).
      if (!hadVideo) {
        const retryAction = action;
        const retryTime = time;
        for (const delay of [400, 1000, 2000]) {
          setTimeout(() => {
            this.player.applyRemote(
              retryAction,
              typeof retryTime === 'number' ? retryTime : undefined
            );
          }, delay);
        }
      }
    }

    /* ----- ad coordination ----- */

    /** Detect local ad transitions and broadcast them to the room. */
    checkAdState() {
      // Some platforms keep ad elements in the DOM at all times (Hotstar).
      // Skip ad coordination there so false positives don't block playback sync.
      if (this.adapter.supportsAdSync === false) {
        if (this.localIsAd) {
          this.localIsAd = false;
          this.send('AD_STATE', { payload: { isAd: false } });
        }
        return;
      }

      const isAd = this.player.isAd();
      if (isAd === this._pendingAdState) {
        this._adStableCount += 1;
      } else {
        this._pendingAdState = isAd;
        this._adStableCount = 1;
      }
      // Require two consecutive polls before acting — stops Hotstar/Prime from
      // flickering ad state and fighting pause/play sync.
      if (this._adStableCount < 2) return;
      if (isAd === this.localIsAd) return;
      this.localIsAd = isAd;
      this.send('AD_STATE', { payload: { isAd } });
      if (isAd) {
        this.broadcastSystemMessage(`⚡ ${this.selfName} is watching an ad…`);
      } else {
        this.broadcastSystemMessage(`⚡ ${this.selfName}'s ad finished.`);
      }
      this.reconcileAds();
    }

    /**
     * Pause our content while any *other* participant is in an ad break, and
     * resume to the intended group state once everyone's ads have finished.
     * (Our own ad plays normally; we only gate the shared content.)
     */
    reconcileAds() {
      if (this.adapter.supportsAdSync === false) return;
      if (this.localIsAd) return; // Our own ad is playing; leave it be.
      const peerInAd = this.remoteAdClients.size > 0;

      if (peerInAd) {
        if (!this.adPaused) {
          this.adPaused = true;
          this.player.applyRemote('pause', this.player.getCurrentTime());
        }
      } else if (this.adPaused) {
        this.adPaused = false;
        if (this.groupPlaying) {
          this.player.applyRemote('play', this.player.getCurrentTime());
        }
      }
    }

    /* ----- navigation (episode change) sync ----- */

    /** Detect a local episode/title change and tell peers to follow. */
    checkNavChange() {
      let key;
      try {
        key = this.adapter.getContentKey?.() || location.href;
      } catch {
        key = location.href;
      }
      if (this.lastContentKey == null) {
        this.lastContentKey = key;
        return;
      }
      if (key === this.lastContentKey) return;
      this.lastContentKey = key;
      this.send('NAV_SYNC', { payload: { url: location.href, contentKey: key } });
      this.broadcastSystemMessage(
        `⚡ ${this.selfName} changed the video to ${this.player.getTitle()}`
      );
    }

    /** Follow a peer to a new episode/title by navigating to their URL. */
    handleRemoteNav(payload) {
      const { url, contentKey } = payload || {};
      if (!url) return;
      let myKey;
      try {
        myKey = this.adapter.getContentKey?.() || location.href;
      } catch {
        myKey = location.href;
      }
      if (contentKey && contentKey === myKey) return; // Already here.

      // Pre-set so the post-navigation page doesn't re-broadcast this change,
      // and adopt the group's state on the freshly loaded page.
      this.lastContentKey = contentKey || myKey;
      this.suppressOutgoingUntil = Date.now() + JOIN_GRACE_MS;
      this.player.setHoldPaused(true);
      try {
        location.href = url;
      } catch (error) {
        console.warn('[WatchSync] Failed to follow navigation:', error);
      }
    }

    /**
     * Send our current playback position/state so a newly joined peer can sync
     * to it. Retried several times because the newcomer's player often mounts
     * after the first message arrives.
     */
    sendCatchUpState() {
      for (const delay of CATCHUP_DELAYS_MS) {
        setTimeout(() => this._sendCatchUpOnce(), delay);
      }
    }

    _sendCatchUpOnce() {
      try {
        let key;
        try {
          key = this.adapter.getContentKey?.() || location.href;
        } catch {
          key = location.href;
        }
        this.send('NAV_SYNC', { payload: { url: location.href, contentKey: key } });

        if (this.adapter.supportsAdSync !== false) {
          this.send('AD_STATE', { payload: { isAd: this.localIsAd } });
        }

        if (!this.player.video && !this.player._bridge.active) return;
        const action = this.player.isPaused() ? 'pause' : 'play';
        const time = this.player.getCurrentTime();
        this.send('SYNC_VIDEO', {
          payload: { action, time, title: this.player.getTitle() },
        });
      } catch (error) {
        console.warn('[WatchSync] Failed to send catch-up state:', error);
      }
    }

    /* ----- chat & profile ----- */

    sendReaction(reactionId) {
      const reaction = REACTION_BY_ID[reactionId];
      if (!reaction) return;
      this.reactionLayer?.spawn(reaction.emoji);
      this.send('REACTION', {
        payload: { id: reactionId, sender: this.selfName },
      });
    }

    sendChat(text) {
      const payload = {
        text,
        sender: this.selfName,
        type: 'user',
        avatar: this.selfAvatar,
      };
      this.send('CHAT_MESSAGE', { payload });
      this.ui.addMessage(
        {
          kind: 'user',
          sender: this.selfName,
          text,
          avatar: this.selfAvatar,
        },
        { notify: false, dismissUnread: true }
      );
    }

    /** Render a system message locally and mirror it to peers. */
    broadcastSystemMessage(text) {
      this.ui.addMessage({ kind: 'system', text }, { notify: false });
      this.send('CHAT_MESSAGE', { payload: { text, sender: 'system', type: 'system' } });
    }

    renameSelf(name) {
      if (name === this.selfName) return;
      const previous = this.selfName;
      this.selfName = name;
      this.ui.setSelfName(name);
      saveProfile({ name });
      this.send('USER_UPDATE', { name, avatar: this.selfAvatar });
      this.broadcastSystemMessage(`⚡ ${previous} is now ${name}`);
    }

    changeAvatar(avatarId) {
      if (!avatarId || this.selfAvatar === avatarId) return;
      this.selfAvatar = avatarId;
      this.ui.setSelfAvatar(avatarId);
      saveProfile({ avatar: avatarId });
      this.send('USER_UPDATE', { name: this.selfName, avatar: avatarId });
    }

    /* ----- teardown ----- */

    leave() {
      this.manualClose = true;
      clearTimeout(this.reconnectTimer);
      clearInterval(this.monitorTimer);
      clearInterval(this.initialSyncTimer);
      clearStoredRoom();
      try {
        this.socket?.close();
      } catch {
        /* ignore */
      }
      this.player.destroy();
      this.reactionLayer?.destroy();
      this.ui.destroy();
      window.__WATCHSYNC_APP__ = null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Cross-frame player bridge (runs inside sub-frames, e.g. Crunchyroll)   */
  /* ---------------------------------------------------------------------- */

  function initFrameBridge() {
    let adapter = null;
    try {
      adapter = pickAdapter();
    } catch {
      adapter = null;
    }
    if (!adapter) return;

    let video = null;
    let suppressUntil = 0;

    const reportState = (action) => {
      if (action !== 'state' && Date.now() < suppressUntil) return; // ignore echoes
      if (!video) return;
      try {
        window.top.postMessage(
          {
            source: FRAME_MSG,
            dir: 'up',
            action,
            time: video.currentTime || 0,
            paused: video.paused,
            isAd: !!adapter.isAd?.(),
          },
          '*'
        );
      } catch {
        /* ignore */
      }
    };

    const onPlay = () => reportState('play');
    const onPause = () => reportState('pause');
    const onSeek = () => reportState('seek');

    const attach = () => {
      let candidate = null;
      try {
        candidate = adapter.getVideo();
      } catch {
        candidate = null;
      }
      if (!candidate || candidate === video) return;
      if (video) {
        video.removeEventListener('play', onPlay);
        video.removeEventListener('pause', onPause);
        video.removeEventListener('seeked', onSeek);
      }
      video = candidate;
      video.addEventListener('play', onPlay);
      video.addEventListener('pause', onPause);
      video.addEventListener('seeked', onSeek);
    };

    try {
      new MutationObserver(() => attach()).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch {
      /* ignore */
    }
    attach();
    setInterval(attach, 2000);
    setInterval(() => reportState('state'), 1000);

    // Apply commands coming down from the top frame.
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.source !== FRAME_MSG || data.dir !== 'down') return;
      if (!video) attach();
      if (!video) return;
      suppressUntil = Date.now() + REMOTE_GUARD_MS;
      try {
        if (
          typeof data.time === 'number' &&
          (data.action === 'seek' ||
            Math.abs(video.currentTime - data.time) > SEEK_THRESHOLD_SECONDS)
        ) {
          video.currentTime = data.time;
        }
        if (data.action === 'play' && video.paused) {
          const r = video.play();
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } else if (data.action === 'pause' && !video.paused) {
          video.pause();
        }
      } catch {
        /* ignore */
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Bootstrapping & messaging with the popup/service worker                */
  /* ---------------------------------------------------------------------- */

  function pickAdapter() {
    const registry = window.WatchSyncAdapters || {};
    const host = location.hostname;
    for (const key of Object.keys(registry)) {
      try {
        if (registry[key].matches(host)) return registry[key];
      } catch {
        /* ignore a faulty adapter */
      }
    }
    return null;
  }

  function ensureApp() {
    if (!isExtensionContextValid()) {
      showReloadBanner();
      return null;
    }
    if (window.__WATCHSYNC_APP__) return window.__WATCHSYNC_APP__;
    const adapter = pickAdapter();
    if (!adapter) {
      console.warn('[WatchSync] No adapter matched this host; aborting.');
      return null;
    }
    window.__WATCHSYNC_APP__ = new WatchSyncApp(adapter);
    return window.__WATCHSYNC_APP__;
  }

  // Listen for commands from the popup (create / join / status query).
  try {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      (async () => {
        try {
          if (request?.type === 'WS_GET_STATE') {
            const app = window.__WATCHSYNC_APP__;
            const adapter = pickAdapter();
            sendResponse({
              supported: !!adapter,
              platform: adapter?.label || null,
              active: !!(app && app.roomId),
              roomId: app?.roomId || null,
              shareLink: app?.roomId ? buildShareLink(app.roomId) : null,
              memberCount: app ? app.members.size : 0,
            });
            return;
          }

          if (request?.type === 'WS_CREATE') {
            const app = ensureApp();
            if (!app) return sendResponse({ ok: false, error: 'unsupported_site' });
            const roomId = request.roomId || self.crypto?.randomUUID?.() || `${Date.now()}`;
            await app.start({ roomId, create: true });
            sendResponse({ ok: true, roomId, shareLink: buildShareLink(roomId) });
            return;
          }

          if (request?.type === 'WS_JOIN') {
            const app = ensureApp();
            if (!app) return sendResponse({ ok: false, error: 'unsupported_site' });
            if (!request.roomId) return sendResponse({ ok: false, error: 'missing_room' });
            await app.start({ roomId: request.roomId, create: false });
            sendResponse({ ok: true, roomId: request.roomId });
            return;
          }

          if (request?.type === 'WS_LEAVE') {
            window.__WATCHSYNC_APP__?.leave();
            sendResponse({ ok: true });
            return;
          }

          sendResponse({ ok: false, error: 'unknown_command' });
        } catch (error) {
          console.warn('[WatchSync] Command handler error:', error);
          sendResponse({ ok: false, error: 'internal_error' });
        }
      })();
      return true; // Keep the message channel open for the async response.
    });
  } catch (error) {
    console.warn('[WatchSync] Could not register runtime listener:', error);
  }

  // Auto-join when the page is opened from a shareable link.
  //
  // Streaming sites are single-page apps that often re-render or tweak the URL
  // shortly after load, which can race with a one-shot join. We therefore:
  //   1. Capture the room id from the hash *immediately* at script load, before
  //      the SPA has a chance to rewrite the URL.
  //   2. Retry the join for a while (the player/DOM may mount late).
  //   3. Watch for in-app navigations (hashchange/popstate + href polling).
  const INITIAL_ROOM = getRoomFromHash();

  function attemptAutoJoin() {
    if (!isExtensionContextValid()) {
      showReloadBanner();
      return true; // Stop retrying — user must reload the tab.
    }
    const roomId = getRoomFromHash() || INITIAL_ROOM;
    if (!roomId) return false;
    const existing = window.__WATCHSYNC_APP__;
    if (existing && existing.roomId) return true; // Already in a room.
    const app = ensureApp();
    if (!app) return false;
    const adapter = pickAdapter();
    setRoomInHash(roomId, adapter);
    app.start({ roomId, create: false });
    return true;
  }

  let autoJoinTries = 0;
  const autoJoinInterval = setInterval(() => {
    if (attemptAutoJoin() || ++autoJoinTries > 15) clearInterval(autoJoinInterval);
  }, 1000);
  attemptAutoJoin(); // Try once right away.

  window.addEventListener('hashchange', attemptAutoJoin);
  window.addEventListener('popstate', attemptAutoJoin);

  // Detect SPA route changes that don't fire hashchange/popstate.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      attemptAutoJoin();
    }
  }, 1500);
})();
