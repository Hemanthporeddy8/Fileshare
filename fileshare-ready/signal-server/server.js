'use strict';

/**
 * FileShare Signal Server
 * Runs FREE on Fly.io — always on, never sleeps.
 *
 * This server does ONE thing only:
 * When Sender connects and Receiver connects to the same room code,
 * it passes messages between them instantly then gets out of the way.
 *
 * It NEVER sees the file. It NEVER stores anything.
 * Messages pass through in ~3 seconds then it is done.
 */

const { WebSocketServer, WebSocket } = require('ws');
const { createServer }               = require('http');

const PORT     = process.env.PORT || 8080;
const ROOM_TTL = 15 * 60 * 1000; // destroy room after 15 min

const rooms = new Map();

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, rooms: rooms.size,
      clients: wss.clients.size,
      uptime: Math.round(process.uptime()) + 's',
    }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws, req) => {
  let code, role;
  try {
    const url = new URL(req.url, 'http://x');
    code = url.searchParams.get('code')?.toUpperCase().slice(0, 6);
    role = url.searchParams.get('role');
  } catch { ws.close(1008, 'Bad URL'); return; }

  if (!code || !/^[A-Z0-9]{6}$/.test(code) || !['sender','receiver'].includes(role)) {
    ws.close(1008, 'Bad params'); return;
  }

  let room = rooms.get(code);
  if (!room) {
    room = { sender: null, receiver: null, timer: null };
    rooms.set(code, room);
    room.timer = setTimeout(() => destroyRoom(code), ROOM_TTL);
  }

  if (role === 'sender'   && room.sender?.readyState   === WebSocket.OPEN) { ws.close(1008, 'Taken'); return; }
  if (role === 'receiver' && room.receiver?.readyState === WebSocket.OPEN) { ws.close(1008, 'Taken'); return; }

  room[role] = ws;

  ws.on('message', (data, isBinary) => {
    const r = rooms.get(code); if (!r) return;
    const other = role === 'sender' ? r.receiver : r.sender;
    if (other?.readyState === WebSocket.OPEN) other.send(data, { binary: isBinary });
    // Message is NOT stored — passes through and is gone instantly
  });

  ws.on('close', () => {
    const r = rooms.get(code); if (!r) return;
    r[role] = null;
    const other = role === 'sender' ? r.receiver : r.sender;
    if (other?.readyState === WebSocket.OPEN)
      other.send(JSON.stringify({ type: 'peer-left', role }));
    if (!r.sender && !r.receiver) destroyRoom(code);
  });

  ws.on('error', () => ws.terminate());
});

function destroyRoom(code) {
  const r = rooms.get(code); if (!r) return;
  clearTimeout(r.timer);
  [r.sender, r.receiver].forEach(ws => {
    if (ws?.readyState === WebSocket.OPEN) ws.close(1001, 'Session ended');
  });
  rooms.delete(code);
}

setInterval(() => {
  console.log(`[${new Date().toISOString()}] rooms=${rooms.size} clients=${wss.clients.size}`);
}, 60_000);

http.listen(PORT, () => {
  console.log(`Signal server on :${PORT}`);
  console.log('Nothing stored. Messages vanish after passing through.');
});
