'use strict';

const express    = require('express');
const { createServer } = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

const PORT        = parseInt(process.env.PORT || '3000', 10);
const UPLOADS_DIR = path.join(os.tmpdir(), 'fileshare_relay');
const FILE_TTL    = 10 * 60 * 1000;
const ROOM_TTL    = 15 * 60 * 1000;
const MAX_RELAY   = parseInt(process.env.MAX_RELAY_MB || '500', 10) * 1024 * 1024;

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const rooms     = new Map();
const fileStore = new Map();

const app  = express();
const http = createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({
  ok: true, rooms: rooms.size, files: fileStore.size,
  uptime: Math.round(process.uptime()),
}));

app.post('/api/relay/upload', (req, res) => {
  res.status(501).json({ error: 'Relay is disabled. Use direct P2P transfer.' });
});

app.get('/api/relay/info/:id', (req, res) => {
  res.status(501).json({ error: 'Relay is disabled.' });
});

app.get('/api/relay/download/:id', (req, res) => {
  res.status(501).json({ error: 'Relay is disabled.' });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// WebSocket signaling
const wss = new WebSocketServer({ noServer: true });

http.on('upgrade', (req, socket, head) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/ws') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    else socket.destroy();
  } catch { socket.destroy(); }
});

wss.on('connection', (ws, req) => {
  let url, code, role;
  try {
    url  = new URL(req.url, 'http://x');
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

  if (role === 'sender'   && room.sender?.readyState   === WebSocket.OPEN) { ws.close(1008, 'Sender taken');   return; }
  if (role === 'receiver' && room.receiver?.readyState === WebSocket.OPEN) { ws.close(1008, 'Receiver taken'); return; }

  room[role] = ws;
  ws._code = code; ws._role = role;

  ws.on('message', (data, binary) => {
    const r = rooms.get(code); if (!r) return;
    const other = role === 'sender' ? r.receiver : r.sender;
    if (other?.readyState === WebSocket.OPEN) other.send(data, { binary });
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
  [r.sender, r.receiver].forEach(c => { if (c?.readyState === WebSocket.OPEN) c.close(1001, 'Session ended'); });
  rooms.delete(code);
}

function purge(meta) {
  try { if (fs.existsSync(meta.filepath)) fs.unlinkSync(meta.filepath); } catch {}
  fileStore.delete(meta.id);
  console.log(`[Relay] -${meta.id} "${meta.name}"`);
}

setInterval(() => {
  const now = Date.now(); let n = 0;
  for (const [, m] of fileStore) if (now > m.expires) { purge(m); n++; }
  if (n) console.log(`[Cleanup] Purged ${n} expired relay files`);
}, 60_000);

http.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════╗`);
  console.log(`  ║   FileShare  ready on :${PORT}      ║`);
  console.log(`  ║   P2P · Relay · Always Free      ║`);
  console.log(`  ╚══════════════════════════════════╝\n`);
});
