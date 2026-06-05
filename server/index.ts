import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { nanoid } from 'nanoid';

import {
  createRoom,
  getRoom,
  loadRoom,
  addParticipant,
  addMessage,
  removeParticipant,
  updateParticipantPersona,
  setGrokThinking,
  setGrokAuto,
  getTyping,
  setTyping,
  clearTyping,
  getRoomState,
  saveRoom,
} from './roomManager.js';
import {
  generateGrokReply,
  forceGrokReply,
  generateNotes,
  generateContextPack,
  isGrokAvailable,
} from './grokClient.js';
import { Message, Participant, Room } from './types.js';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*', // MVP: allow any for easy remote/tunnels
    methods: ['GET', 'POST'],
  },
  // ping settings for low latency feel
  pingInterval: 10000,
  pingTimeout: 5000,
});

const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- REST API ---

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, grok: isGrokAvailable(), time: Date.now() });
});

// Create new room
app.post('/api/rooms', async (req, res) => {
  const { name = '', purpose = '', password = '' } = req.body || {};
  if (!password || !/^\d{4}$/.test(password)) {
    return res.status(400).json({ error: 'A 4-digit password is required to create a chat group' });
  }
  const room = createRoom(name, purpose, password);
  console.log(`[room] created ${room.id} "${room.name}"`);
  res.json({ roomId: room.id, createdAt: room.createdAt });
});

// Get room meta (public info, no full messages if want privacy but for MVP ok)
app.get('/api/rooms/:id', async (req, res) => {
  const id = (req.params.id || '').trim().toUpperCase();
  let room = getRoom(id);
  if (!room) {
    room = await loadRoom(id);
  }
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({
    id: room.id,
    name: room.name || 'Untitled Chat',
    purpose: room.purpose || '',
    createdAt: room.createdAt,
    participantCount: Object.keys(room.participants).length,
    messageCount: room.messages.length,
    grokAuto: room.grokAuto,
    hasPassword: !!room.password,
  });
});

// Export full transcript (md or json) - also used by socket but REST for direct download
app.get('/api/rooms/:id/export', async (req, res) => {
  const id = (req.params.id || '').trim().toUpperCase();
  const format = (req.query.format as string) || 'md';
  let room = getRoom(id);
  if (!room) room = await loadRoom(id);
  if (!room) return res.status(404).json({ error: 'Not found' });

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="collab-${id}.json"`);
    return res.send(JSON.stringify({ roomId: id, exportedAt: new Date().toISOString(), ...room }, null, 2));
  }

  // md
  const lines = [
    `# collab-grok — ${id}`,
    `Exported: ${new Date().toISOString()}`,
    '',
    '## Participants',
  ];
  Object.values(room.participants).forEach(p => {
    lines.push(`- **${p.name}**: ${p.persona}`);
  });
  lines.push('', '## Transcript', '');
  room.messages.forEach(m => {
    const t = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    lines.push(`**${m.name}** [${t}]`);
    lines.push(m.content);
    lines.push('');
  });
  if (room.summary) {
    lines.push('## Context Summary (compacted)');
    lines.push(room.summary);
  }

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="collab-${id}.md"`);
  res.send(lines.join('\n'));
});

// Generate notes (server side, returns markdown)
app.post('/api/rooms/:id/notes', async (req, res) => {
  const id = (req.params.id || '').trim().toUpperCase();
  let room = getRoom(id);
  if (!room) room = await loadRoom(id);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  try {
    const notes = await generateNotes(room);
    console.log(`[room ${id}] generated notes`);
    res.json({ notes, roomId: id });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to generate notes' });
  }
});

// Generate + save context pack (md + json) to disk
app.post('/api/rooms/:id/context-pack', async (req, res) => {
  const id = (req.params.id || '').trim().toUpperCase();
  let room = getRoom(id);
  if (!room) room = await loadRoom(id);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  try {
    const { md, json } = await generateContextPack(room);

    // Ensure exports dir
    const exportDir = path.join(process.cwd(), 'context-packs');
    await fs.mkdir(exportDir, { recursive: true });

    const base = `context-${id}-${Date.now().toString(36)}`;
    const mdPath = path.join(exportDir, `${base}.md`);
    const jsonPath = path.join(exportDir, `${base}.json`);

    await fs.writeFile(mdPath, md, 'utf-8');
    await fs.writeFile(jsonPath, JSON.stringify(json, null, 2), 'utf-8');

    console.log(`[room ${id}] generated context pack -> ${path.relative(process.cwd(), mdPath)}`);

    res.json({
      ok: true,
      mdPath: path.relative(process.cwd(), mdPath),
      jsonPath: path.relative(process.cwd(), jsonPath),
      mdPreview: md.slice(0, 1200),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to generate context pack' });
  }
});

// --- Static serving (for production/preview) ---
const clientDist = path.join(process.cwd(), 'client/dist');
app.use(express.static(clientDist));

// SPA fallback for client routes (room links etc) — Express 5 compatible
app.get(/.*/, async (req, res) => {
  // Don't intercept API or socket
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
    return res.status(404).end();
  }
  const indexPath = path.join(clientDist, 'index.html');
  try {
    await fs.access(indexPath);
    res.sendFile(indexPath);
  } catch {
    res.status(503).send('Client not built. Run `npm run build` or use `npm run dev`.');
  }
});

// --- Socket.IO real-time ---

// Track socket -> {roomId, userId}
const socketMeta = new Map<string, { roomId: string; userId: string }>();

function broadcastRoomUpdate(room: Room) {
  const state = getRoomState(room);
  io.to(room.id).emit('room:updated', {
    participants: state.participants,
    grokAuto: state.grokAuto,
  });
}

function broadcastTyping(roomId: string) {
  const typing = getTyping(roomId);
  io.to(roomId).emit('typing:update', typing);
}

io.on('connection', (socket) => {
  socket.on('room:join', async (data: { roomId: string; name: string; persona: string; password?: string }) => {
    try {
      let { roomId, name, persona } = data;
      roomId = (roomId || '').trim().toUpperCase();
      if (!roomId || !name) {
        socket.emit('error', 'roomId and name are required');
        return;
      }

      let room = getRoom(roomId);
      if (!room) {
        room = await loadRoom(roomId);
      }
      if (!room) {
        socket.emit('error', 'Room not found. Check the code or create a new one.');
        return;
      }

      // Verify password if set
      if (room.password) {
        const provided = data.password || '';
        const hashedProvided = crypto.createHash('sha256').update(provided).digest('hex');
        if (hashedProvided !== room.password) {
          socket.emit('error', 'Incorrect 4-digit password for this chat.');
          return;
        }
      }

      // Enforce max ~4 humans
      const currentHumans = Object.keys(room.participants).length;
      if (currentHumans >= 4) {
        socket.emit('error', 'This room already has 4 collaborators (max).');
        return;
      }

      // Create userId for this socket connection (simple, per join)
      const userId = `u_${nanoid(6)}`;

      const participant = addParticipant(room, userId, name, persona || 'Collaborator contributing unique perspective.');

      // Join socket room
      socket.join(roomId);
      socketMeta.set(socket.id, { roomId, userId });

      // Welcome
      const state = getRoomState(room);
      socket.emit('room:joined', { room: state, yourId: userId });

      // Notify others
      socket.to(roomId).emit('system', `${participant.name} joined the discussion.`);
      console.log(`[room ${roomId}] ${participant.name} (${userId}) joined`);

      // If first messages empty, perhaps seed a welcome from Grok? Skip for clean.

      broadcastRoomUpdate(room);
    } catch (e: any) {
      console.error('join error', e);
      socket.emit('error', 'Failed to join room');
    }
  });

  socket.on('persona:update', (newPersona: string) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = getRoom(meta.roomId);
    if (!room) return;

    updateParticipantPersona(room, meta.userId, newPersona);
    broadcastRoomUpdate(room);
    socket.to(meta.roomId).emit('system', `Participant updated their persona.`);
  });

  socket.on('message:send', async (content: string) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) {
      socket.emit('error', 'Not in a room');
      return;
    }
    const room = getRoom(meta.roomId);
    if (!room) return;

    const p = room.participants[meta.userId];
    if (!p) return;

    const trimmed = content.trim();
    if (!trimmed) return;

    const msg: Message = {
      id: `m-${Date.now()}-${nanoid(5)}`,
      role: 'user',
      userId: meta.userId,
      name: p.name,
      content: trimmed,
      ts: Date.now(),
    };

    addMessage(room, msg);

    // Broadcast to room
    io.to(meta.roomId).emit('message:new', msg);
    console.log(`[room ${meta.roomId}] ${p.name}: ${trimmed.slice(0, 90)}${trimmed.length > 90 ? '…' : ''}`);

    // Clear this user's typing
    setTyping(meta.roomId, meta.userId, false);
    broadcastTyping(meta.roomId);

    // Trigger Grok if auto enabled (debounced via setTimeout)
    if (room.grokAuto && isGrokAvailable()) {
      // Debounce: cancel previous pending grok for room
      console.log(`[room ${meta.roomId}] scheduling Grok think (auto)`);
      scheduleGrokThink(meta.roomId, 1400);
    }
  });

  socket.on('typing:start', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    setTyping(meta.roomId, meta.userId, true);
    broadcastTyping(meta.roomId);
  });

  socket.on('typing:stop', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    setTyping(meta.roomId, meta.userId, false);
    broadcastTyping(meta.roomId);
  });

  socket.on('grok:summon', async () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = getRoom(meta.roomId);
    if (!room || !isGrokAvailable()) {
      socket.emit('error', 'Grok is not available right now.');
      return;
    }
    if (room.grokThinking) {
      socket.emit('system', 'Grok is already thinking...');
      return;
    }

    console.log(`[room ${meta.roomId}] Grok summoned by ${room.participants[meta.userId]?.name || meta.userId}`);
    // Immediately show thinking to all
    setGrokThinking(room, true);
    io.to(meta.roomId).emit('grok:thinking', true);

    try {
      const reply = await forceGrokReply(room, (thinking) => {
        setGrokThinking(room, thinking);
        io.to(meta.roomId).emit('grok:thinking', thinking);
      });

      if (reply) {
        io.to(meta.roomId).emit('message:new', reply);
        console.log(`[room ${meta.roomId}] Grok replied (summoned)`);
      } else {
        io.to(meta.roomId).emit('system', 'Grok considered but had nothing to add this time.');
        console.log(`[room ${meta.roomId}] Grok silence (summoned)`);
      }
    } catch (e: any) {
      io.to(meta.roomId).emit('system', `Grok error: ${e.message || 'try again'}`);
      setGrokThinking(room, false);
      io.to(meta.roomId).emit('grok:thinking', false);
    }
  });

  socket.on('room:toggle-grok-auto', (enabled: boolean) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = getRoom(meta.roomId);
    if (!room) return;

    setGrokAuto(room, !!enabled);
    broadcastRoomUpdate(room);
    io.to(meta.roomId).emit('system', `Grok auto-participation ${enabled ? 'enabled' : 'disabled'}.`);
  });

  socket.on('room:leave', () => {
    handleDisconnect(socket, true);
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });

  // Simple export trigger over socket (client can use REST too)
  socket.on('export:request', async (format: 'json' | 'md' = 'md') => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = getRoom(meta.roomId);
    if (!room) return;

    // Reuse the logic from REST by just emitting content
    let content: string;
    let filename: string;

    if (format === 'json') {
      content = JSON.stringify({ roomId: room.id, exportedAt: new Date().toISOString(), ...room }, null, 2);
      filename = `collab-${room.id}.json`;
    } else {
      const lines: string[] = [
        `# collab-grok — ${room.id}`,
        `Exported: ${new Date().toISOString()}`,
        '',
        '## Participants',
      ];
      Object.values(room.participants).forEach((p: Participant) => {
        lines.push(`- **${p.name}**: ${p.persona}`);
      });
      lines.push('', '## Transcript', '');
      room.messages.forEach((m: Message) => {
        const t = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        lines.push(`**${m.name}** [${t}]`);
        lines.push(m.content.replace(/\n/g, '\n> '));
        lines.push('');
      });
      if (room.summary) {
        lines.push('## Compacted Context');
        lines.push(room.summary);
      }
      content = lines.join('\n');
      filename = `collab-${room.id}.md`;
    }

    socket.emit('export:ready', { format, content, filename });
  });
});

function handleDisconnect(socket: any, explicit = false) {
  const meta = socketMeta.get(socket.id);
  if (!meta) return;

  const { roomId, userId } = meta;
  const room = getRoom(roomId);
  socketMeta.delete(socket.id);

  if (room) {
    const p = room.participants[userId];
    const wasOnline = !!p;

    // Remove from typing
    setTyping(roomId, userId, false);
    broadcastTyping(roomId);

    // We keep the participant record (for history attribution) but mark offline implicitly via presence.
    // For MVP, we don't auto-remove; they stay in the list. User can rejoin with same name.
    // If you want hard leave: removeParticipant(room, userId);

    if (wasOnline && explicit) {
      socket.to(roomId).emit('system', `${p.name} left.`);
    }

    // Do not delete room on empty - persist for resume.
    broadcastRoomUpdate(room);
  }
}

// --- Grok auto-think scheduler (per room debounce) ---
const grokTimers = new Map<string, NodeJS.Timeout>();

function scheduleGrokThink(roomId: string, delayMs = 1400) {
  // Clear existing
  const existing = grokTimers.get(roomId);
  if (existing) clearTimeout(existing);

  const t = setTimeout(async () => {
    grokTimers.delete(roomId);

    const room = getRoom(roomId);
    if (!room || !room.grokAuto || room.grokThinking || !isGrokAvailable()) return;

    // Don't think if last message was from Grok recently
    const last = room.messages[room.messages.length - 1];
    if (last && last.role === 'grok' && Date.now() - last.ts < 8000) return;

    setGrokThinking(room, true);
    io.to(roomId).emit('grok:thinking', true);

    try {
      const reply = await generateGrokReply(room, (thinking) => {
        setGrokThinking(room, thinking);
        io.to(roomId).emit('grok:thinking', thinking);
      });

      if (reply) {
        io.to(roomId).emit('message:new', reply);
        console.log(`[room ${roomId}] Grok replied`);
      } else {
        console.log(`[room ${roomId}] Grok chose silence`);
      }
      // silence: just stop thinking (already done inside)
    } catch (e: any) {
      console.error('Auto grok failed', e.message);
      setGrokThinking(room, false);
      io.to(roomId).emit('grok:thinking', false);
      io.to(roomId).emit('system', 'Grok failed to respond (check API key / rate limits).');
    }
  }, delayMs);

  grokTimers.set(roomId, t);
}

// Start server
server.listen(PORT, () => {
  console.log(`\n🚀 collab-grok server running on http://localhost:${PORT}`);
  console.log(`   - Web UI served at http://localhost:${PORT}`);
  console.log(`   - For remote collab: use ngrok/cloudflared tunnel on this port`);
  console.log(`   - Grok enabled: ${isGrokAvailable()}`);
  console.log(`   - Create room or join via UI\n`);
});

// Graceful
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close(() => process.exit(0));
});
