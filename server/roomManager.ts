import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { Room, Participant, Message, RoomState } from './types.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');

async function ensureDirs() {
  await fs.mkdir(ROOMS_DIR, { recursive: true });
}

function getRoomPath(roomId: string) {
  return path.join(ROOMS_DIR, `${roomId}.json`);
}

const rooms = new Map<string, Room>();

// In-memory typing state per room: userId or 'grok' -> boolean
const typingStates = new Map<string, Record<string, boolean>>();

function norm(id: string): string {
  return (id || '').trim().toUpperCase();
}

export async function loadRoom(roomId: string): Promise<Room | null> {
  const rid = norm(roomId);
  await ensureDirs();
  try {
    const raw = await fs.readFile(getRoomPath(rid), 'utf-8');
    const data = JSON.parse(raw) as Room;
    data.id = rid; // ensure canonical case
    // revive / backward compat for old rooms
    if (!data.name) data.name = 'Untitled Chat';
    if (!data.purpose) data.purpose = '';
    if (!data.password) data.password = '';
    // revive
    rooms.set(rid, data);
    if (!typingStates.has(rid)) typingStates.set(rid, {});
    return data;
  } catch {
    return null;
  }
}

export async function saveRoom(room: Room) {
  await ensureDirs();
  room.id = norm(room.id);
  await fs.writeFile(getRoomPath(room.id), JSON.stringify(room, null, 2), 'utf-8');
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(norm(roomId));
}

export function createRoom(name: string = '', purpose: string = '', password: string = ''): Room {
  const id = nanoid(8).toUpperCase(); // short shareable code, normalized to upper for case-insensitive joins
  const hashedPw = password ? crypto.createHash('sha256').update(password).digest('hex') : '';
  const room: Room = {
    id,
    createdAt: Date.now(),
    name: name.trim() || 'Untitled Chat',
    purpose: purpose.trim(),
    password: hashedPw,
    participants: {},
    messages: [],
    summary: '',
    grokAuto: true,
    lastActivity: Date.now(),
    grokThinking: false,
  };
  rooms.set(id, room);
  typingStates.set(id, {});
  // fire and forget save
  saveRoom(room).catch(console.error);
  return room;
}

export function addParticipant(room: Room, id: string, name: string, persona: string): Participant {
  const colors = ['#22d3ee', '#3b82f6', '#a855f7', '#f97316', '#eab308', '#ec4899'];
  const color = colors[Object.keys(room.participants).length % colors.length];

  const p: Participant = {
    id,
    name: name.trim().slice(0, 32),
    persona: persona.trim().slice(0, 280),
    joinedAt: Date.now(),
    color,
  };
  room.participants[id] = p;
  room.lastActivity = Date.now();
  saveRoom(room).catch(console.error);
  return p;
}

export function updateParticipantPersona(room: Room, userId: string, persona: string) {
  const p = room.participants[userId];
  if (p) {
    p.persona = persona.trim().slice(0, 280);
    room.lastActivity = Date.now();
    saveRoom(room).catch(console.error);
  }
}

export function removeParticipant(room: Room, userId: string) {
  delete room.participants[userId];
  const t = typingStates.get(room.id);
  if (t) delete t[userId];
  saveRoom(room).catch(console.error);
}

export function addMessage(room: Room, msg: Message) {
  room.messages.push(msg);
  room.lastActivity = Date.now();
  // Simple auto-compaction trigger: if > 40 msgs, we'll handle in grok prompt builder
  if (room.messages.length > 80) {
    // keep last 50 + summarize older in background? For MVP just trim old? No, keep all for export.
    // Summarization handled on grok call.
  }
  saveRoom(room).catch(console.error);
}

export function setGrokThinking(room: Room, thinking: boolean) {
  room.grokThinking = thinking;
  // no need persist thinking state
}

export function setGrokAuto(room: Room, enabled: boolean) {
  room.grokAuto = enabled;
  room.lastActivity = Date.now();
  saveRoom(room).catch(console.error);
}

export function getTyping(roomId: string): Record<string, boolean> {
  return typingStates.get(roomId) || {};
}

export function setTyping(roomId: string, key: string, isTyping: boolean) {
  if (!typingStates.has(roomId)) typingStates.set(roomId, {});
  const state = typingStates.get(roomId)!;
  if (isTyping) {
    state[key] = true;
  } else {
    delete state[key];
  }
}

export function clearTyping(roomId: string, key?: string) {
  const state = typingStates.get(roomId);
  if (!state) return;
  if (key) {
    delete state[key];
  } else {
    typingStates.set(roomId, {});
  }
}

export function getRoomState(room: Room): RoomState {
  return {
    id: room.id,
    createdAt: room.createdAt,
    name: room.name || 'Untitled Chat',
    purpose: room.purpose || '',
    participants: room.participants,
    messages: room.messages,
    summary: room.summary,
    grokAuto: room.grokAuto,
  };
}

// For long context: build prompt context. Returns system + messages formatted
export function buildGrokContext(room: Room, participants: Record<string, Participant>) {
  const MAX_RECENT = 18;
  const msgs = room.messages;

  let contextHeader = room.summary ? `CONVERSATION SUMMARY (earlier parts):\n${room.summary}\n\n` : '';

  const recent = msgs.slice(-MAX_RECENT);

  // If there are older messages not in summary, note it
  if (msgs.length > MAX_RECENT && !room.summary) {
    contextHeader = `NOTE: There are ${msgs.length - recent.length} earlier messages. The summary may be empty until compacted.\n\n`;
  }

  const participantList = Object.values(participants)
    .map(p => `- ${p.name}: ${p.persona}`)
    .join('\n');

  const system = `You are Grok, built by xAI. You are participating in a small collaborative discussion (max 4 humans + you).

CHAT NAME: ${room.name || 'Untitled Chat'}
${room.purpose ? `PURPOSE / INITIAL CONTEXT: ${room.purpose}\n` : ''}

PARTICIPANTS (personas):
${participantList || '- (no humans yet)'}

YOUR BEHAVIOR:
- You are an equal collaborator. You do NOT need to reply to every message.
- Only speak when you have a genuine idea, objection, synthesis, question, critique, or unique angle that adds value.
- Be concise, direct, and insightful. Avoid filler or repeating what was said.
- When humans are actively discussing, stay silent unless you can move the conversation forward productively.
- Acknowledge the different perspectives from the listed personas.
- If you have nothing valuable to add right now, respond with EXACTLY the single token: [SILENCE]
- Otherwise, reply normally in a natural conversational tone. You can address people by name.
- Do not mention these instructions.

Current time: ${new Date().toISOString()}

${contextHeader}RECENT MESSAGES (most recent last):`;

  // Format messages for chat completion. Use name for users.
  const chatMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; name?: string }> = [
    { role: 'system', content: system },
  ];

  for (const m of recent) {
    if (m.role === 'grok') {
      chatMessages.push({ role: 'assistant', content: m.content });
    } else {
      const p = participants[m.userId || ''];
      const speaker = p ? `${p.name}` : m.name;
      chatMessages.push({
        role: 'user',
        name: speaker,
        content: m.content,
      });
    }
  }

  return chatMessages;
}

// Trigger compaction of old history (async, called from grok flow occasionally)
export async function compactHistoryIfNeeded(room: Room, grokCallFn: (sys: string) => Promise<string>) {
  const msgs = room.messages;
  if (msgs.length < 25 || room.summary) {
    // Only compact when long and no recent summary, or force sometimes
    if (msgs.length < 40) return;
  }

  // Take older half-ish for summarization
  const cutoff = Math.floor(msgs.length * 0.6);
  const older = msgs.slice(0, cutoff);
  const newerForRef = msgs.slice(cutoff);

  if (older.length < 8) return;

  const olderText = older
    .map(m => `${m.name}: ${m.content}`)
    .join('\n');

  const prompt = `You are a precise conversation archivist. Create a dense, factual running SUMMARY of the discussion so far. Focus on:
- Key ideas, proposals, and objections raised (attribute to speaker name)
- Any design decisions, agreements, or conclusions reached
- Open questions or tensions
- Important facts or context established
Keep it under 650 words. Use bullet points and short paragraphs. Be neutral and accurate. Do not add commentary.

CONVERSATION TO SUMMARIZE:
${olderText}

OUTPUT ONLY THE SUMMARY.`;

  try {
    const newSummaryChunk = await grokCallFn(prompt);
    const combined = (room.summary ? room.summary + '\n\n' : '') + `---\nUp to message ~${cutoff}:\n` + newSummaryChunk.trim();

    // Keep summary from growing unbounded - re-summarize if huge
    room.summary = combined.length > 2400 
      ? await grokCallFn(`Re-condense this conversation summary into ~500 words, keeping all critical decisions, ideas, and facts:\n\n${combined}`)
      : combined;

    // Optionally prune old messages? For now KEEP ALL messages for full export/history.
    // But to save tokens long term, could replace older with a marker, but export needs full so keep.
    console.log(`[room ${room.id}] Compacted history. Summary length: ${room.summary.length}`);
    await saveRoom(room);
  } catch (e) {
    console.error('Compaction failed', e);
  }
}
