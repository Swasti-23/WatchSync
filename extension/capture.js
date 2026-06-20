/**
 * WatchSync — early room-id capture (runs at document_start).
 * --------------------------------------------------------------------------
 * Some streaming single-page apps (Hotstar in particular) rewrite the URL and
 * drop the `#wsRoom=...` fragment very early during their boot, before the main
 * content script (which runs at document_idle) gets a chance to read it.
 *
 * This tiny script runs at document_start — the earliest possible moment — and
 * stashes the room id into the tab's sessionStorage so content.js can recover
 * it later even after the hash has been stripped.
 * --------------------------------------------------------------------------
 */
(function captureWatchSyncRoom() {
  'use strict';
  try {
    const hash = (location.hash || '').replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const room = params.get('wsRoom');
    if (room && room.trim()) {
      sessionStorage.setItem('__watchsync_room__', room.trim());
    }
  } catch (error) {
    /* sessionStorage or URL parsing unavailable — nothing we can do this early */
  }
})();
