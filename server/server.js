/**
 * WatchSync Signaling Server
 * --------------------------------------------------------------------------
 * A lean, dependency-light WebSocket relay for the WatchSync watch-party
 * browser extension. It keeps zero persistent state: rooms and their members
 * live entirely in-memory inside plain Map/Set structures and are garbage
 * collected the moment the last participant disconnects.
 *
 * The server is intentionally "dumb": it validates the message envelope,
 * tracks room membership, and rebroadcasts events to the other members of the
 * same room. All synchronization intelligence lives inside the extension.
 *
 * Protocol (every message is a JSON object with a `type` field):
 *   Client -> Server:
 *     ROOM_CREATE  { roomId?, profile }
 *     ROOM_JOIN    { roomId, profile }
 *     USER_UPDATE  { name }
 *     SYNC_VIDEO   { payload: { action, time, title? } }
 *     CHAT_MESSAGE { payload: { text, sender, type } }
 *     PING
 *   Server -> Client:
 *     ROOM_STATE   { roomId, you, members }   (sent to the requester)
 *     PEER_JOINED  { member }                 (broadcast to others)
 *     PEER_LEFT    { clientId, name }          (broadcast to others)
 *     USER_UPDATE  { clientId, name }          (broadcast to others)
 *     SYNC_VIDEO   { from, payload }           (broadcast to others)
 *     CHAT_MESSAGE { from, payload }           (broadcast to others)
 *     ERROR        { message }
 *     PONG
 * --------------------------------------------------------------------------
 */

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT) || 8080;
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * rooms: Map<roomId, Room>
 *   Room = { id, members: Map<clientId, Member> }
 *   Member = { clientId, name, socket }
 */
const rooms = new Map();

const wss = new WebSocketServer({ port: PORT });

console.log(`[WatchSync] Signaling server listening on ws://localhost:${PORT}`);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Safely serialize and send a JSON payload over a socket. */
function send(socket, type, data = {}) {
  if (!socket || socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify({ type, ...data }));
  } catch (error) {
    console.error('[WatchSync] Failed to send message:', error.message);
  }
}

/** Broadcast to every member of a room except (optionally) one client. */
function broadcastToRoom(roomId, type, data, exceptClientId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const member of room.members.values()) {
    if (member.clientId === exceptClientId) continue;
    send(member.socket, type, data);
  }
}

/** Build a lightweight, serializable list of members for a room. */
function serializeMembers(room) {
  return [...room.members.values()].map((m) => ({
    clientId: m.clientId,
    name: m.name,
    avatar: m.avatar || null,
  }));
}

/** Remove a client from its current room, cleaning up empty rooms. */
function leaveCurrentRoom(state) {
  if (!state.roomId) return;
  const room = rooms.get(state.roomId);
  if (!room) {
    state.roomId = null;
    return;
  }

  room.members.delete(state.clientId);
  broadcastToRoom(state.roomId, 'PEER_LEFT', {
    clientId: state.clientId,
    name: state.name,
  });

  if (room.members.size === 0) {
    rooms.delete(room.id);
    console.log(`[WatchSync] Room ${room.id} is empty and was removed.`);
  }
  state.roomId = null;
}

/** Join (or create) a room and announce the new member. */
function joinRoom(state, roomId) {
  // Leave any previous room first to avoid leaking membership.
  leaveCurrentRoom(state);

  let room = rooms.get(roomId);
  if (!room) {
    room = { id: roomId, members: new Map() };
    rooms.set(roomId, room);
    console.log(`[WatchSync] Room ${roomId} created.`);
  }

  const member = {
    clientId: state.clientId,
    name: state.name,
    avatar: state.avatar || null,
    socket: state.socket,
  };
  room.members.set(state.clientId, member);
  state.roomId = roomId;

  // Tell the requester about the full room state.
  send(state.socket, 'ROOM_STATE', {
    roomId,
    you: { clientId: state.clientId, name: state.name, avatar: state.avatar || null },
    members: serializeMembers(room),
  });

  // Tell everyone else that a new peer arrived.
  broadcastToRoom(
    roomId,
    'PEER_JOINED',
    { member: { clientId: state.clientId, name: state.name, avatar: state.avatar || null } },
    state.clientId
  );

  console.log(
    `[WatchSync] ${state.name} (${state.clientId}) joined room ${roomId}. ` +
      `Members: ${room.members.size}`
  );
}

/* -------------------------------------------------------------------------- */
/* Connection lifecycle                                                       */
/* -------------------------------------------------------------------------- */

wss.on('connection', (socket) => {
  // Per-connection state. clientId is the server's source of truth identity.
  const state = {
    clientId: randomUUID(),
    name: 'Guest',
    avatar: null,
    roomId: null,
    socket,
  };

  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      send(socket, 'ERROR', { message: 'Malformed JSON payload.' });
      return;
    }

    if (!message || typeof message.type !== 'string') {
      send(socket, 'ERROR', { message: 'Missing message type.' });
      return;
    }

    try {
      handleMessage(state, message);
    } catch (error) {
      console.error('[WatchSync] Error handling message:', error);
      send(socket, 'ERROR', { message: 'Internal server error.' });
    }
  });

  socket.on('close', () => {
    leaveCurrentRoom(state);
  });

  socket.on('error', (error) => {
    console.error('[WatchSync] Socket error:', error.message);
  });
});

/* -------------------------------------------------------------------------- */
/* Message router                                                             */
/* -------------------------------------------------------------------------- */

function handleMessage(state, message) {
  switch (message.type) {
    case 'ROOM_CREATE': {
      // Honor a client-provided roomId (generated via crypto.randomUUID in the
      // extension) so the shareable link is known before the round trip.
      const roomId =
        typeof message.roomId === 'string' && message.roomId.trim()
          ? message.roomId.trim()
          : randomUUID();
      if (message.profile?.name) state.name = String(message.profile.name);
      if (message.profile?.avatar) state.avatar = String(message.profile.avatar);
      joinRoom(state, roomId);
      break;
    }

    case 'ROOM_JOIN': {
      const roomId =
        typeof message.roomId === 'string' ? message.roomId.trim() : '';
      if (!roomId) {
        send(state.socket, 'ERROR', { message: 'A roomId is required to join.' });
        return;
      }
      if (message.profile?.name) state.name = String(message.profile.name);
      if (message.profile?.avatar) state.avatar = String(message.profile.avatar);
      joinRoom(state, roomId);
      break;
    }

    case 'USER_UPDATE': {
      const newName = typeof message.name === 'string' ? message.name.trim() : '';
      if (!newName) return;
      state.name = newName;
      const room = state.roomId ? rooms.get(state.roomId) : null;
      if (room && room.members.has(state.clientId)) {
        const member = room.members.get(state.clientId);
        member.name = newName;
        if (typeof message.avatar === 'string') member.avatar = message.avatar;
      }
      broadcastToRoom(
        state.roomId,
        'USER_UPDATE',
        {
          clientId: state.clientId,
          name: newName,
          avatar: typeof message.avatar === 'string' ? message.avatar : undefined,
        },
        state.clientId
      );
      break;
    }

    case 'SYNC_VIDEO': {
      if (!state.roomId) return;
      broadcastToRoom(
        state.roomId,
        'SYNC_VIDEO',
        { from: state.clientId, payload: message.payload || {} },
        state.clientId
      );
      break;
    }

    case 'NAV_SYNC': {
      // Episode/title change: rebroadcast so peers can follow to the new page.
      if (!state.roomId) return;
      broadcastToRoom(
        state.roomId,
        'NAV_SYNC',
        { from: state.clientId, payload: message.payload || {} },
        state.clientId
      );
      break;
    }

    case 'AD_STATE': {
      // A peer entered/left an ad break; relay so others can pause/resume.
      if (!state.roomId) return;
      broadcastToRoom(
        state.roomId,
        'AD_STATE',
        { from: state.clientId, payload: message.payload || {} },
        state.clientId
      );
      break;
    }

    case 'CHAT_MESSAGE': {
      if (!state.roomId) return;
      broadcastToRoom(
        state.roomId,
        'CHAT_MESSAGE',
        { from: state.clientId, payload: message.payload || {} },
        state.clientId
      );
      break;
    }

    case 'REACTION': {
      if (!state.roomId) return;
      broadcastToRoom(
        state.roomId,
        'REACTION',
        { from: state.clientId, payload: message.payload || {} },
        state.clientId
      );
      break;
    }

    case 'PING': {
      send(state.socket, 'PONG');
      break;
    }

    default:
      send(state.socket, 'ERROR', {
        message: `Unknown message type: ${message.type}`,
      });
  }
}

/* -------------------------------------------------------------------------- */
/* Heartbeat: drop dead sockets to keep room membership accurate.             */
/* -------------------------------------------------------------------------- */

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    try {
      socket.ping();
    } catch {
      socket.terminate();
    }
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeat));

/* Graceful shutdown. */
function shutdown() {
  console.log('\n[WatchSync] Shutting down...');
  clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, 'Server shutting down');
  wss.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
