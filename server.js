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
const ROOM_TTL    = 24 * 60 * 60 * 1000; // 24 hours
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

  if (!code || !/^[A-Z0-9]{6}$/.test(code) || !['sender','receiver','inbox'].includes(role)) {
    ws.close(1008, 'Bad params'); return;
  }

  let room = rooms.get(code);
  if (!room) {
    room = { sender: null, receiver: null, inbox: null, senders: new Map(), timer: null, buffer: [] };
    rooms.set(code, room);
    room.timer = setTimeout(() => destroyRoom(code), ROOM_TTL);
  }

  const isInbox = url.searchParams.get('isInbox') === 'true';
  const senderId = url.searchParams.get('senderId');
  const isInboxSender = (role === 'sender' && (isInbox || room.inbox || senderId));

  if (role === 'inbox' && room.inbox?.readyState === WebSocket.OPEN) {
    ws.close(1008, 'Inbox taken'); return;
  }
  if (role === 'receiver' && room.receiver?.readyState === WebSocket.OPEN) {
    ws.close(1008, 'Receiver taken'); return;
  }
  if (role === 'sender' && !isInboxSender && room.sender?.readyState === WebSocket.OPEN) {
    ws.close(1008, 'Sender taken'); return;
  }
  if (role === 'sender' && isInboxSender) {
    if (!senderId) {
      ws.close(1008, 'Sender ID required for inbox mode'); return;
    }
    if (room.senders.get(senderId)?.readyState === WebSocket.OPEN) {
      ws.close(1008, 'Sender ID taken'); return;
    }
  }

  ws._code = code;
  ws._role = role;

  if (role === 'inbox') {
    room.inbox = ws;
    // Flush any buffered messages from senders to the inbox
    if (room.buffer && room.buffer.length > 0) {
      room.buffer.forEach(msg => {
        if (msg.role === 'sender') {
          if (!msg.binary) {
            try {
              const parsed = JSON.parse(msg.data.toString());
              parsed.senderId = msg.senderId;
              ws.send(JSON.stringify(parsed));
            } catch {
              ws.send(msg.data, { binary: msg.binary });
            }
          } else {
            ws.send(msg.data, { binary: msg.binary });
          }
        }
      });
      room.buffer = room.buffer.filter(msg => msg.role !== 'sender');
    }
    // Notify about any existing senders that connected before the inbox receiver
    for (const [sId, sWs] of room.senders) {
      if (sWs.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'peer-joined', senderId: sId }));
      }
    }
  } else if (role === 'receiver') {
    room.receiver = ws;
    // Flush buffered messages for receiver
    if (room.buffer && room.buffer.length > 0) {
      room.buffer.forEach(msg => {
        if (msg.role === 'sender') {
          ws.send(msg.data, { binary: msg.binary });
        }
      });
      room.buffer = room.buffer.filter(msg => msg.role !== 'sender');
    }
  } else if (role === 'sender' && isInboxSender) {
    ws._senderId = senderId;
    ws._isInboxSender = true;
    room.senders.set(senderId, ws);
    // Flush buffered messages from inbox to this sender
    if (room.buffer && room.buffer.length > 0) {
      room.buffer.forEach(msg => {
        if (msg.role === 'inbox' && msg.targetSenderId === senderId) {
          ws.send(msg.data, { binary: msg.binary });
        }
      });
      room.buffer = room.buffer.filter(msg => !(msg.role === 'inbox' && msg.targetSenderId === senderId));
    }
    // Notify inbox receiver that this sender joined
    if (room.inbox?.readyState === WebSocket.OPEN) {
      room.inbox.send(JSON.stringify({ type: 'peer-joined', senderId }));
    }
  } else {
    // 1-to-1 sender
    room.sender = ws;
    // Flush buffered messages for sender
    if (room.buffer && room.buffer.length > 0) {
      room.buffer.forEach(msg => {
        if (msg.role === 'receiver') {
          ws.send(msg.data, { binary: msg.binary });
        }
      });
      room.buffer = room.buffer.filter(msg => msg.role !== 'receiver');
    }
  }

  ws.on('message', (data, binary) => {
    const r = rooms.get(code); if (!r) return;
    if (role === 'inbox') {
      try {
        const parsed = JSON.parse(data.toString());
        const targetSenderId = parsed.targetSenderId;
        if (targetSenderId) {
          const senderWs = r.senders.get(targetSenderId);
          if (senderWs?.readyState === WebSocket.OPEN) {
            senderWs.send(data, { binary });
          } else {
            if (!r.buffer) r.buffer = [];
            r.buffer.push({ role: 'inbox', targetSenderId, data, binary });
          }
        }
      } catch (err) {
        console.error('[Inbox] Error parsing receiver message', err);
      }
    } else if (role === 'receiver') {
      const other = r.sender;
      if (other?.readyState === WebSocket.OPEN) {
        other.send(data, { binary });
      } else {
        if (!r.buffer) r.buffer = [];
        r.buffer.push({ role: 'receiver', data, binary });
      }
    } else if (ws._isInboxSender) {
      const other = r.inbox;
      if (other?.readyState === WebSocket.OPEN) {
        // Inject senderId into the message string if it's JSON
        if (!binary) {
          try {
            const parsed = JSON.parse(data.toString());
            parsed.senderId = ws._senderId;
            other.send(JSON.stringify(parsed));
          } catch {
            other.send(data, { binary });
          }
        } else {
          other.send(data, { binary });
        }
      } else {
        if (!r.buffer) r.buffer = [];
        r.buffer.push({ role: 'sender', senderId: ws._senderId, data, binary });
      }
    } else {
      // 1-to-1 sender
      const other = r.receiver;
      if (other?.readyState === WebSocket.OPEN) {
        other.send(data, { binary });
      } else {
        if (!r.buffer) r.buffer = [];
        r.buffer.push({ role: 'sender', data, binary });
      }
    }
  });

  ws.on('close', () => {
    const r = rooms.get(code); if (!r) return;
    if (role === 'inbox') {
      r.inbox = null;
      for (const [, sWs] of r.senders) {
        if (sWs.readyState === WebSocket.OPEN) {
          sWs.send(JSON.stringify({ type: 'peer-left', role: 'inbox' }));
        }
      }
    } else if (ws._isInboxSender) {
      r.senders.delete(ws._senderId);
      if (r.inbox?.readyState === WebSocket.OPEN) {
        r.inbox.send(JSON.stringify({ type: 'peer-left', senderId: ws._senderId }));
      }
    } else if (role === 'receiver') {
      r.receiver = null;
      if (r.sender?.readyState === WebSocket.OPEN) {
        r.sender.send(JSON.stringify({ type: 'peer-left', role: 'receiver' }));
      }
    } else if (role === 'sender') {
      r.sender = null;
      if (r.receiver?.readyState === WebSocket.OPEN) {
        r.receiver.send(JSON.stringify({ type: 'peer-left', role: 'sender' }));
      }
    }

    const hasActiveSenders = Array.from(r.senders.values()).some(s => s.readyState === WebSocket.OPEN);
    if (!r.sender && !r.receiver && !r.inbox && !hasActiveSenders) {
      destroyRoom(code);
    }
  });

  ws.on('error', () => ws.terminate());
});

function destroyRoom(code) {
  const r = rooms.get(code); if (!r) return;
  clearTimeout(r.timer);
  [r.sender, r.receiver, r.inbox].forEach(c => { if (c?.readyState === WebSocket.OPEN) c.close(1001, 'Session ended'); });
  for (const [, sWs] of r.senders) {
    if (sWs?.readyState === WebSocket.OPEN) sWs.close(1001, 'Session ended');
  }
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

// Keep-alive heartbeat to prevent background tabs from disconnecting
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  });
}, 20_000);

http.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════╗`);
  console.log(`  ║   FileShare  ready on :${PORT}      ║`);
  console.log(`  ║   P2P · Relay · Always Free      ║`);
  console.log(`  ╚══════════════════════════════════╝\n`);
});
