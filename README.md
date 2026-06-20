# WatchSync — Watch Party Browser Extension

Watch **Netflix, Amazon Prime Video, Disney+ Hotstar, YouTube and Crunchyroll**
in perfect sync with friends, with an integrated live chat sidebar. No login,
no accounts — just share a link.

- **Zero auth** — instant create/join via a shareable Room link.
- **Ephemeral profiles** — random guest name you can rename anytime.
- **Real-time sync** — Play / Pause / Seek mirrored to everyone (<200ms).
- **Live chat** — isolated Shadow-DOM sidebar embedded in the page.
- **System notifications** — e.g. `⚡ Swift Guest 402 paused at 12:34`.
- **Manifest V3** — works in Chrome, Edge and Brave.

---

## Project structure

```
extension/                 # The browser extension (load this unpacked)
  manifest.json            # MV3 manifest
  background.js            # Service worker (thin: injection bridge + defaults)
  content.js              # Player sync + Shadow-DOM chat sidebar + WS client
  injection_hosts/        # One PlayerAdapter per platform
    netflix.js  prime.js  hotstar.js  youtube.js  crunchyroll.js
  popup.html / popup.js   # Toolbar popup (create / join / leave)
  styles.css              # Sidebar styles (loaded inside the Shadow DOM)
  icons/                  # Generated PNG icons
server/                    # Signaling/relay server (run this with Node)
  package.json
  server.js               # In-memory WebSocket relay (no database)
```

---

## 1. Run the signaling server

You need **Node.js 18+** installed (`node -v`).

```bash
cd server
npm install        # installs the single dependency: ws
npm start          # -> ws://localhost:8080
```

You should see: `[WatchSync] Signaling server listening on ws://localhost:8080`.

> The server keeps everything in memory (rooms in a `Map`). Stop it with
> `Ctrl+C`; nothing is persisted.

### Deploying for friends on other networks
`localhost` only works on your own machine. To watch with remote friends, host
`server/` on any Node-capable host (Render, Railway, Fly.io, a VPS, etc.) behind
**WSS** (secure WebSocket), then set that URL in the extension popup under
**Advanced: signaling server** (e.g. `wss://your-host.example.com`).

---

## 2. Load the extension (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the **WatchSync** icon to your toolbar.

> Every teammate must load the same extension and point at the **same**
> signaling server (default `ws://localhost:8080`, configurable in the popup).

---

## 3. Start a watch party

1. Open a video on a supported site (Netflix, Prime Video, Hotstar, YouTube,
   Crunchyroll) and start playing it.
2. Click the **WatchSync** toolbar icon. It shows the detected platform.
3. Click **Create a watch party**. The chat sidebar appears on the right.
4. Click **Copy link** (in the popup or the sidebar) and send it to friends.

## 4. Join a watch party

- **Easiest:** open the shared link — the extension auto-joins and opens the
  sidebar (make sure the link opens on the supported site).
- **Or:** click the toolbar icon, paste the link/Room ID into **Join**, and
  press **Join**.

Now Play, Pause and Seek by anyone are synced to everyone, and the chat logs
system events automatically.

In the sidebar you can:
- Change your display name in the **You:** field (everyone is notified).
- Send chat messages.
- Collapse (`—`) or leave (`✕`) the party.

---

## How synchronization works (and stays loop-free)

When you press pause, `content.js` sends a `SYNC_VIDEO` event to the relay,
which rebroadcasts it to the other room members. Each receiver applies the
action to its own `<video>` element. To avoid the classic **infinite sync
loop** (applying a remote pause fires a local `pause` event that would be
re-broadcast), the `PlayerController` raises a short-lived **synchronization
guard** (`suppressUntil`) while applying remote commands, so the resulting
"echo" events are ignored.

### WebSocket message schema
Every message is JSON with a `type` field:

| type           | direction       | payload |
| -------------- | --------------- | ------- |
| `ROOM_CREATE`  | client → server | `{ roomId?, profile:{name} }` |
| `ROOM_JOIN`    | client → server | `{ roomId, profile:{name} }` |
| `USER_UPDATE`  | both            | `{ name }` / `{ clientId, name }` |
| `SYNC_VIDEO`   | both            | `{ action:'play'\|'pause'\|'seek', time, title? }` |
| `CHAT_MESSAGE` | both            | `{ text, sender, type:'user'\|'system' }` |
| `ROOM_STATE` / `PEER_JOINED` / `PEER_LEFT` | server → client | membership updates |

---

## Adding a new platform

1. Create `extension/injection_hosts/<platform>.js` registering an adapter on
   `window.WatchSyncAdapters` with `matches(hostname)`, `getVideo()` and
   `getTitle()` (copy an existing one).
2. Add its host(s) to `host_permissions`, `content_scripts.matches` and
   `web_accessible_resources.matches` in `manifest.json`.
3. Add the file to `content_scripts.js` (and to `background.js`’s injection
   list). No changes to `content.js` are required.

---

## Troubleshooting

- **Popup says "Unsupported"** — you're not on a supported site, or the page was
  open before installing. Reload the tab.
- **Sidebar but no sync** — confirm the server is running and that every member
  uses the same signaling URL. Check the page console for `[WatchSync]` logs.
- **Netflix/DRM seeking feels off** — DRM players can throttle programmatic
  seeks; WatchSync uses the standard HTML5 `currentTime` API and tolerates small
  drift (`SEEK_THRESHOLD_SECONDS`).
- **Autoplay blocked on remote play** — browsers may block programmatic play;
  just click play once to satisfy the autoplay policy.

## Regenerating icons (optional)
```bash
node extension/icons/generate-icons.mjs
```
