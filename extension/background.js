/**
 * WatchSync — background service worker (Manifest V3).
 * --------------------------------------------------------------------------
 * The watch-party WebSocket lives inside each tab's content script (one tab ==
 * one participant), so this worker stays deliberately thin. It:
 *   - Seeds a sensible default server URL on install.
 *   - Bridges popup <-> content script when the popup needs to inject the
 *     content script into a tab that loaded before the extension was enabled.
 *   - Keeps the action icon state tidy.
 *
 * Note: service workers in MV3 are ephemeral and may be terminated at any
 * time. We therefore keep no long-lived in-memory state here.
 * --------------------------------------------------------------------------
 */

const DEFAULT_SERVER_URL = 'ws://localhost:8080';

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const existing = await chrome.storage.local.get('serverUrl');
    if (!existing.serverUrl) {
      await chrome.storage.local.set({ serverUrl: DEFAULT_SERVER_URL });
    }
  } catch (error) {
    console.warn('[WatchSync][bg] Failed to seed defaults:', error);
  }
});

/**
 * The popup may target a tab whose content script has not been injected yet
 * (e.g. the tab was open before install). This helper guarantees the content
 * script is present before the popup sends it a command.
 */
async function ensureContentScript(tabId) {
  try {
    // Cheap probe: if this resolves, the script is already there.
    await chrome.tabs.sendMessage(tabId, { type: 'WS_GET_STATE' });
    return true;
  } catch {
    // Not injected yet — inject the adapters + content script in order.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'injection_hosts/netflix.js',
          'injection_hosts/prime.js',
          'injection_hosts/hotstar.js',
          'injection_hosts/youtube.js',
          'injection_hosts/crunchyroll.js',
          'avatars.js',
          'content.js',
        ],
      });
      return true;
    } catch (error) {
      console.warn('[WatchSync][bg] Injection failed:', error);
      return false;
    }
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type === 'WS_ENSURE_INJECTED' && typeof request.tabId === 'number') {
    ensureContentScript(request.tabId).then((ok) => sendResponse({ ok }));
    return true; // async response
  }
  return false;
});
