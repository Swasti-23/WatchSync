# WatchSync — Watch Party Browser Extension

**Version 0.0.1** · First release

Watch **Netflix, Amazon Prime Video, Disney+ Hotstar, YouTube, and Crunchyroll** in sync with friends, with a live chat sidebar built into the page. No login, no accounts — share a link and start watching together.

---

## Features

- **Zero auth** — create or join a room instantly via a shareable link.
- **Guest profiles** — random name on join; rename anytime and pick a cartoon avatar.
- **Real-time sync** — play, pause, and seek stay in sync for everyone in the room.
- **Live chat** — chat sidebar on the streaming page with system notifications (e.g. who paused and when).
- **Five platforms** — Netflix, Prime Video, Hotstar, YouTube, and Crunchyroll.
- **Chrome, Edge, and Brave** — load the extension unpacked (not on any store yet).

---

## How to run

### 1. Start the signaling server

Requires **Node.js 18+**.

```bash
cd server
npm install
npm start
```

You should see `[WatchSync] Signaling server listening on ws://localhost:8080`.

To watch with friends on other networks, deploy the `server/` folder to a host with **WSS** and set that URL in the extension popup under **Advanced: signaling server**.

### 2. Load the extension

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin **WatchSync** to your toolbar.

Everyone in a party needs the extension and the **same signaling server URL** (default `ws://localhost:8080`).

### 3. Create a watch party

1. Open a supported site and start a video.
2. Click the **WatchSync** icon → **Create a watch party**.
3. Copy the room link and send it to friends.

### 4. Join a watch party

- Open the shared link on a supported site, or
- Click the **WatchSync** icon, paste the link or room ID, and press **Join**.

Use the sidebar to chat, change your name or avatar, or leave the party.
