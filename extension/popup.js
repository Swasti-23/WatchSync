/**
 * WatchSync — popup controller.
 * Talks to the active tab's content script to create / join / leave a party,
 * and reflects the current session state in the popup UI.
 */
(function popupMain() {
  'use strict';

  const els = {
    platformPill: document.getElementById('platformPill'),
    inactiveView: document.getElementById('inactiveView'),
    activeView: document.getElementById('activeView'),
    createBtn: document.getElementById('createBtn'),
    joinInput: document.getElementById('joinInput'),
    joinBtn: document.getElementById('joinBtn'),
    shareLink: document.getElementById('shareLink'),
    copyBtn: document.getElementById('copyBtn'),
    membersText: document.getElementById('membersText'),
    leaveBtn: document.getElementById('leaveBtn'),
    status: document.getElementById('status'),
    serverUrl: document.getElementById('serverUrl'),
  };

  let activeTabId = null;

  function setStatus(text, kind) {
    els.status.textContent = text || '';
    els.status.className = `status ${kind || ''}`.trim();
  }

  /** Extract a room id from a pasted shareable link or a raw id string. */
  function parseRoomId(raw) {
    const value = (raw || '').trim();
    if (!value) return null;
    try {
      const url = new URL(value);
      const hash = (url.hash || '').replace(/^#/, '');
      const params = new URLSearchParams(hash);
      const room = params.get('wsRoom');
      if (room) return room.trim();
    } catch {
      /* not a URL — treat as a raw room id */
    }
    return value;
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  /** Send a message to the content script, injecting it first if necessary. */
  async function messageContent(payload) {
    if (activeTabId == null) throw new Error('no_tab');
    try {
      return await chrome.tabs.sendMessage(activeTabId, payload);
    } catch {
      // Content script not present yet — ask the worker to inject it.
      await chrome.runtime.sendMessage({ type: 'WS_ENSURE_INJECTED', tabId: activeTabId });
      return await chrome.tabs.sendMessage(activeTabId, payload);
    }
  }

  function renderActive(state) {
    els.inactiveView.classList.add('hidden');
    els.activeView.classList.remove('hidden');
    els.shareLink.value = state.shareLink || '';
    els.membersText.textContent =
      state.memberCount === 1 ? '1 watching' : `${state.memberCount} watching`;
  }

  function renderInactive() {
    els.activeView.classList.add('hidden');
    els.inactiveView.classList.remove('hidden');
  }

  async function refreshState() {
    let state;
    try {
      state = await messageContent({ type: 'WS_GET_STATE' });
    } catch {
      state = null;
    }

    if (!state || !state.supported) {
      els.platformPill.textContent = 'Unsupported';
      els.platformPill.className = 'pill no';
      els.createBtn.disabled = true;
      els.joinBtn.disabled = true;
      setStatus('Open Netflix, Prime, Hotstar, YouTube or Crunchyroll to start.', '');
      renderInactive();
      return;
    }

    els.platformPill.textContent = state.platform;
    els.platformPill.className = 'pill ok';
    els.createBtn.disabled = false;
    els.joinBtn.disabled = false;

    if (state.active) {
      renderActive(state);
    } else {
      renderInactive();
    }
  }

  async function handleCreate() {
    setStatus('Creating party…', '');
    els.createBtn.disabled = true;
    try {
      const res = await messageContent({ type: 'WS_CREATE' });
      if (res?.ok) {
        setStatus('Party created!', 'ok');
        await refreshState();
      } else {
        setStatus('Could not create party here.', 'error');
        els.createBtn.disabled = false;
      }
    } catch {
      setStatus('Could not reach this page. Reload and try again.', 'error');
      els.createBtn.disabled = false;
    }
  }

  async function handleJoin() {
    const roomId = parseRoomId(els.joinInput.value);
    if (!roomId) {
      setStatus('Paste a valid room link or ID.', 'error');
      return;
    }
    setStatus('Joining party…', '');
    try {
      const res = await messageContent({ type: 'WS_JOIN', roomId });
      if (res?.ok) {
        setStatus('Joined!', 'ok');
        await refreshState();
      } else {
        setStatus('Could not join here.', 'error');
      }
    } catch {
      setStatus('Could not reach this page. Reload and try again.', 'error');
    }
  }

  async function handleLeave() {
    try {
      await messageContent({ type: 'WS_LEAVE' });
    } catch {
      /* ignore */
    }
    setStatus('Left the party.', '');
    renderInactive();
    await refreshState();
  }

  function handleCopy() {
    els.shareLink.select();
    navigator.clipboard?.writeText(els.shareLink.value).then(
      () => {
        els.copyBtn.textContent = 'Copied!';
        setTimeout(() => (els.copyBtn.textContent = 'Copy'), 1500);
      },
      () => document.execCommand?.('copy')
    );
  }

  async function loadServerUrl() {
    try {
      const { serverUrl } = await chrome.storage.local.get('serverUrl');
      els.serverUrl.value = serverUrl || 'ws://localhost:8080';
    } catch {
      els.serverUrl.value = 'ws://localhost:8080';
    }
  }

  async function saveServerUrl() {
    const url = els.serverUrl.value.trim() || 'ws://localhost:8080';
    try {
      await chrome.storage.local.set({ serverUrl: url });
    } catch {
      /* ignore */
    }
  }

  /* ----- wire up ----- */
  els.createBtn.addEventListener('click', handleCreate);
  els.joinBtn.addEventListener('click', handleJoin);
  els.joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleJoin();
  });
  els.copyBtn.addEventListener('click', handleCopy);
  els.leaveBtn.addEventListener('click', handleLeave);
  els.serverUrl.addEventListener('change', saveServerUrl);
  els.serverUrl.addEventListener('blur', saveServerUrl);

  (async function init() {
    const tab = await getActiveTab();
    activeTabId = tab?.id ?? null;
    await loadServerUrl();
    await refreshState();
  })();
})();
