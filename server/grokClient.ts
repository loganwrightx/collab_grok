import OpenAI from 'openai';
import dotenv from 'dotenv';
import { buildGrokContext, compactHistoryIfNeeded, getRoom, saveRoom } from './roomManager.js';
import { Room, Participant, Message } from './types.js';

dotenv.config();

const apiKey = process.env.XAI_API_KEY || '';
const MODEL = process.env.XAI_MODEL || 'grok-3'; // override in .env e.g. grok-4.3 or grok-4-1-fast-reasoning

let grokAvailable = !!apiKey;

if (!apiKey) {
  console.warn('⚠️  XAI_API_KEY not set. Grok features will be disabled until .env is configured.');
}

export function isGrokAvailable() {
  return grokAvailable;
}

function getOpenAI() {
  if (!apiKey) throw new Error('Grok API key not configured');
  return new OpenAI({
    apiKey,
    baseURL: 'https://api.x.ai/v1',
  });
}

async function callGrok(messages: any[], options?: { maxTokens?: number; temperature?: number }) {
  if (!grokAvailable) throw new Error('Grok API key not configured');

  const openai = getOpenAI();
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages,
    temperature: options?.temperature ?? 0.75,
    max_tokens: options?.maxTokens ?? 900,
    stream: false,
  });

  return completion.choices[0]?.message?.content?.trim() || '';
}

// Non-stream version for simplicity + reliability in MVP (low latency via fast model)
export async function generateGrokReply(
  room: Room,
  onThinking: (thinking: boolean) => void,
  onPartial?: (text: string) => void // reserved for future streaming
): Promise<Message | null> {
  onThinking(true);

  const participants = room.participants;

  try {
    // Occasionally compact before building context (cheap check)
    if (room.messages.length > 30 && Math.random() < 0.35) {
      await compactHistoryIfNeeded(room, (sysPrompt) =>
        callGrok([{ role: 'user', content: sysPrompt }], { maxTokens: 700, temperature: 0.3 })
      );
    }

    const chatMessages = buildGrokContext(room, participants);

    // Add a final instruction nudge as last "user" to decide
    chatMessages.push({
      role: 'user',
      name: 'system',
      content: 'Decide now: if you have something valuable to contribute (idea, objection, question, synthesis, or clarification), reply with your message. Otherwise reply with exactly [SILENCE]. No preamble.',
    });

    const raw = await callGrok(chatMessages, { temperature: 0.8, maxTokens: 850 });

    if (!raw) {
      onThinking(false);
      return null;
    }

    const cleaned = raw.replace(/^\[SILENCE\].*$/is, '[SILENCE]').trim();

    if (cleaned.toUpperCase() === '[SILENCE]' || cleaned === '[SILENCE]') {
      onThinking(false);
      return null;
    }

    // Valid contribution
    const msg: Message = {
      id: `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'grok',
      name: 'Grok',
      content: cleaned,
      ts: Date.now(),
    };

    // Add to room
    room.messages.push(msg);
    room.lastActivity = Date.now();
    await saveRoom(room);

    onThinking(false);
    return msg;
  } catch (err: any) {
    console.error('Grok generation error:', err?.message || err);
    onThinking(false);
    // Return a soft error message? Or let caller handle.
    throw err;
  }
}

// Force / summon without the silence option. Used for the "Grok, your thoughts?" button.
export async function forceGrokReply(
  room: Room,
  onThinking: (thinking: boolean) => void
): Promise<Message | null> {
  onThinking(true);

  try {
    if (room.messages.length > 28 && Math.random() < 0.4) {
      await compactHistoryIfNeeded(room, (p) =>
        callGrok([{ role: 'user', content: p }], { maxTokens: 650, temperature: 0.2 })
      );
    }

    const chatMessages = buildGrokContext(room, room.participants);

    chatMessages.push({
      role: 'user',
      name: 'system',
      content: 'Please contribute now with any useful thoughts, critiques, ideas or questions you have based on the discussion. Be concise and valuable. Address specific people if helpful.',
    });

    const content = await callGrok(chatMessages, { temperature: 0.75, maxTokens: 900 });

    if (!content) {
      onThinking(false);
      return null;
    }

    const msg: Message = {
      id: `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'grok',
      name: 'Grok',
      content,
      ts: Date.now(),
    };

    room.messages.push(msg);
    room.lastActivity = Date.now();
    await saveRoom(room);

    onThinking(false);
    return msg;
  } catch (err) {
    console.error('Force Grok error', err);
    onThinking(false);
    throw err;
  }
}

// Generate structured notes (for "Build notes" feature)
export async function generateNotes(room: Room): Promise<string> {
  if (!grokAvailable) throw new Error('Grok not available - set XAI_API_KEY');

  const fullTranscript = room.messages
    .map(m => `[${new Date(m.ts).toISOString().slice(11,19)}] ${m.name}: ${m.content}`)
    .join('\n\n');

  const participants = Object.values(room.participants)
    .map(p => `${p.name} — ${p.persona}`)
    .join('\n');

  const sys = `You are an expert technical note-taker and synthesizer.

Create high-quality, structured notes from this collaborative discussion.

OUTPUT FORMAT (use markdown):

# Discussion Notes — ${room.id}

**Date:** ${new Date(room.createdAt).toISOString().slice(0,10)}
**Participants:**
${participants || 'Grok only'}

## Executive Summary
(2-4 sentences capturing the essence and outcome direction)

## Key Ideas & Perspectives
- Bullet list. Attribute to speaker where distinctive.

## Design Decisions & Agreements
- For each: What was decided, rationale, who drove it, status (proposed/accepted)

## Solutions & Proposals
- Notable technical or creative proposals

## Open Questions & Tensions
- What remains unresolved or debated

## Action Items / Next Steps
- (if any surfaced)

## Grok's Notable Contributions
- (if any)

Be precise, quote key phrases sparingly, avoid fluff. Max ~900 words total.`;

  const userMsg = `FULL TRANSCRIPT:\n${fullTranscript}\n\n${room.summary ? 'RUNNING SUMMARY:\n' + room.summary : ''}`;

  const notes = await callGrok(
    [
      { role: 'system', content: sys },
      { role: 'user', content: userMsg },
    ],
    { temperature: 0.4, maxTokens: 1400 }
  );

  return notes;
}

// Generate catch-up context pack for future Grok sessions (dense + structured)
export async function generateContextPack(room: Room): Promise<{ md: string; json: any }> {
  if (!grokAvailable) throw new Error('Grok not available - set XAI_API_KEY');

  const transcript = room.messages
    .map(m => `${m.name}: ${m.content}`)
    .join('\n');

  const participantsStr = Object.values(room.participants)
    .map(p => `- ${p.name}: ${p.persona}`).join('\n');

  const prompt = `You are preparing a self-contained "catch-up pack" so that a future instance of Grok (or another LLM) can instantly understand and continue this exact collaborative conversation without losing any critical information.

Produce TWO outputs:

1. A dense, highly factual CONTEXT FILE in markdown. Start with:
# COLLAB CONTEXT — ${room.id}
**Participants and their lenses:**
${participantsStr}

Then sections:
## Timeline of Major Turns (concise)
## Established Facts & Context
## Key Decisions (with who + why)
## Core Ideas & Divergent Views (by persona)
## Open Problems / Questions
## Terminology & Agreements
## Grok's Previous Stance / Contributions (if relevant)
Keep extremely information-dense. Use bullets and short sentences. ~650 words max.

2. ALSO output a machine-readable JSON object ONLY (no markdown wrapper) with this exact shape at the end after the md:
\`\`\`json
{
  "roomId": "${room.id}",
  "generatedAt": "${new Date().toISOString()}",
  "participants": [{"name": "...", "persona": "..."}],
  "keyDecisions": [{"decision": "string", "rationale": "string", "championedBy": ["names"], "ts": 123}],
  "ideas": [{"idea": "...", "by": "name", "status": "proposed|discussed|accepted"}],
  "openQuestions": ["..."],
  "facts": ["..."],
  "terminology": {"term": "def"},
  "grokContributions": ["..."]
}
\`\`\`

Now analyze and output the markdown first, then exactly one \`\`\`json block.`;

  const fullInput = (room.summary ? `PRIOR SUMMARY:\n${room.summary}\n\n` : '') + `TRANSCRIPT:\n${transcript}`;

  const raw = await callGrok(
    [
      { role: 'system', content: prompt },
      { role: 'user', content: fullInput },
    ],
    { temperature: 0.3, maxTokens: 1800 }
  );

  // Parse out the json if present
  let md = raw;
  let json: any = {};

  const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    md = raw.replace(/```json[\s\S]*?```/, '').trim();
    try {
      json = JSON.parse(jsonMatch[1]);
    } catch {
      json = { parseError: true, raw: jsonMatch[1].slice(0, 400) };
    }
  }

  return { md, json };
}
