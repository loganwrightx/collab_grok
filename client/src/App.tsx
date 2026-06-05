import React, { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Send, Users, Copy, Download, FileText, Brain, MessageCircle, X, Edit2, Play, Pause, Plus
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from './lib/utils';
import type { Participant, Message, RoomState, TypingMap } from './types';

const isDev = import.meta.env.DEV;
const API_BASE = ''; // relative paths — works via Vite proxy in dev and same-origin in prod
const SOCKET_URL = isDev
  ? (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:3000'
  : (import.meta.env.VITE_SERVER_URL as string) || window.location.origin;

let socket: Socket | null = null;

function connectSocket() {
  if (socket?.connected) return socket;
  socket = io(SOCKET_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 8,
  });
  return socket;
}

export default function App() {
  const [view, setView] = useState<'lobby' | 'chat'>('lobby');
  const [room, setRoom] = useState<RoomState | null>(null);
  const [yourId, setYourId] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [participants, setParticipants] = useState<Record<string, Participant>>({});
  const [grokAuto, setGrokAuto] = useState(true);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [typing, setTyping] = useState<TypingMap>({});
  const [grokThinking, setGrokThinking] = useState(false);

  // Lobby state
  const [joinCode, setJoinCode] = useState('');
  const [myName, setMyName] = useState('');
  const [myPersona, setMyPersona] = useState('Product thinker focused on clarity, user value, and practical tradeoffs.');
  const [isJoining, setIsJoining] = useState(false);

  // Modals
  const [notesModal, setNotesModal] = useState<{ open: boolean; content: string; loading: boolean }>({ open: false, content: '', loading: false });
  const [contextModal, setContextModal] = useState<{ open: boolean; md: string; paths: { md: string; json: string } | null; loading: boolean }>({ open: false, md: '', paths: null, loading: false });
  const [editingPersonaFor, setEditingPersonaFor] = useState<string | null>(null);
  const [editPersonaText, setEditPersonaText] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  // Auto scroll
  const scrollToBottom = (smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
  };

  useEffect(() => {
    if (messages.length > 0) {
      // slight delay for render
      setTimeout(() => scrollToBottom(), 40);
    }
  }, [messages, typing, grokThinking]);

  // URL room prefill (e.g. /r/abc123 or ?room= )
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pathRoom = window.location.pathname.match(/\/r\/([a-zA-Z0-9_-]{4,12})/)?.[1];
    const qRoom = params.get('room') || params.get('r');
    const initialRoom = pathRoom || qRoom;
    if (initialRoom) {
      setJoinCode(initialRoom.toUpperCase());
    }
  }, []);

  // Socket listeners setup (once)
  useEffect(() => {
    const s = connectSocket();

    s.on('connect', () => {
      // ok
    });

    s.on('room:joined', ({ room, yourId }: { room: RoomState; yourId: string }) => {
      setRoom(room);
      setYourId(yourId);
      setMessages(room.messages || []);
      setParticipants(room.participants || {});
      setGrokAuto(room.grokAuto);
      setGrokThinking(false);
      setTyping({});
      setView('chat');
      setIsJoining(false);
      toast.success(`Joined room ${room.id}`);
      // update url without reload for shareability
      const url = new URL(window.location.href);
      url.searchParams.set('room', room.id);
      window.history.replaceState({}, '', url.toString());
    });

    s.on('room:updated', ({ participants: p, grokAuto: ga }: { participants: Record<string, Participant>; grokAuto: boolean }) => {
      setParticipants(p);
      setGrokAuto(ga);
      if (room) setRoom({ ...room, participants: p, grokAuto: ga });
    });

    s.on('message:new', (msg: Message) => {
      setMessages(prev => [...prev, msg]);
    });

    s.on('grok:thinking', (isThinking: boolean) => {
      setGrokThinking(isThinking);
      if (!isThinking) {
        // also clear grok from typing if present
        setTyping(prev => {
          const next = { ...prev };
          delete next['grok'];
          return next;
        });
      }
    });

    s.on('typing:update', (t: TypingMap) => {
      setTyping(t);
    });

    s.on('system', (text: string) => {
      // lightweight system notice as a pseudo message
      const sysMsg: Message = {
        id: `sys-${Date.now()}`,
        role: 'grok',
        name: 'System',
        content: text,
        ts: Date.now(),
      };
      setMessages(prev => [...prev, sysMsg]);
    });

    s.on('error', (msg: string) => {
      toast.error(msg);
      setIsJoining(false);
    });

    s.on('export:ready', ({ content, filename }: { content: string; filename: string }) => {
      downloadText(content, filename);
      toast.success(`Downloaded ${filename}`);
    });

    return () => {
      s.off('room:joined');
      s.off('room:updated');
      s.off('message:new');
      s.off('grok:thinking');
      s.off('typing:update');
      s.off('system');
      s.off('error');
      s.off('export:ready');
    };
  }, []);

  // Join / Create flow
  async function createRoomAndJoin() {
    if (!myName.trim()) {
      toast.error('Please enter your name');
      return;
    }
    setIsJoining(true);
    try {
      const res = await fetch(`${API_BASE}/api/rooms`, { method: 'POST' });
      const { roomId } = await res.json();
      joinRoom(roomId, myName.trim(), myPersona.trim());
    } catch (e) {
      toast.error('Failed to create room');
      setIsJoining(false);
    }
  }

  function joinRoom(roomId: string, name: string, persona: string) {
    const s = connectSocket();
    setIsJoining(true);
    s.emit('room:join', { roomId: roomId.trim().toUpperCase(), name, persona });
  }

  function handleJoinExisting() {
    if (!joinCode.trim()) {
      toast.error('Enter a room code');
      return;
    }
    if (!myName.trim()) {
      toast.error('Enter your name to join');
      return;
    }
    joinRoom(joinCode, myName.trim(), myPersona.trim());
  }

  // Messaging
  function sendMessage() {
    if (!input.trim() || !socket || isSending) return;
    setIsSending(true);

    socket.emit('message:send', input.trim());
    setInput('');

    // stop typing
    socket.emit('typing:stop');

    setTimeout(() => {
      setIsSending(false);
      inputRef.current?.focus();
    }, 120);
  }

  function handleInputKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);

    // typing indicators (debounced stop)
    if (!socket || !room) return;

    socket.emit('typing:start');

    if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => {
      socket?.emit('typing:stop');
    }, 1400);
  }

  // Persona edit
  function startEditPersona(userId: string) {
    const p = participants[userId];
    if (!p) return;
    if (userId !== yourId) {
      toast.info('You can only edit your own persona');
      return;
    }
    setEditingPersonaFor(userId);
    setEditPersonaText(p.persona);
  }

  function savePersona() {
    if (!editingPersonaFor || !socket) return;
    const trimmed = editPersonaText.trim();
    if (trimmed) {
      socket.emit('persona:update', trimmed);
    }
    setEditingPersonaFor(null);
    setEditPersonaText('');
  }

  // Grok controls
  function toggleGrokAuto() {
    if (!socket) return;
    const next = !grokAuto;
    socket.emit('room:toggle-grok-auto', next);
    // optimistic
    setGrokAuto(next);
  }

  function summonGrok() {
    if (!socket) return;
    socket.emit('grok:summon');
    toast('Summoned Grok...');
  }

  // Export / Notes / Context
  async function exportChat(format: 'md' | 'json') {
    if (!room) return;
    // Prefer socket for instant, falls back to REST
    if (socket) {
      socket.emit('export:request', format);
    } else {
      // direct
      const url = `${API_BASE}/api/rooms/${room.id}/export?format=${format}`;
      window.open(url, '_blank');
    }
  }

  async function buildNotes() {
    if (!room) return;
    setNotesModal({ open: true, content: '', loading: true });

    try {
      const res = await fetch(`${API_BASE}/api/rooms/${room.id}/notes`, { method: 'POST' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setNotesModal({ open: true, content: data.notes, loading: false });
    } catch (e: any) {
      setNotesModal({ open: false, content: '', loading: false });
      toast.error(e.message || 'Failed to build notes');
    }
  }

  async function generateContextPack() {
    if (!room) return;
    setContextModal({ open: true, md: '', paths: null, loading: true });

    try {
      const res = await fetch(`${API_BASE}/api/rooms/${room.id}/context-pack`, { method: 'POST' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setContextModal({
        open: true,
        md: data.mdPreview || data.md || 'Context pack generated.',
        paths: { md: data.mdPath, json: data.jsonPath },
        loading: false,
      });
      toast.success('Context pack saved on server');
    } catch (e: any) {
      setContextModal({ open: false, md: '', paths: null, loading: false });
      toast.error(e.message || 'Failed to generate context pack');
    }
  }

  function downloadText(text: string, filename: string) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadNotes() {
    if (!notesModal.content || !room) return;
    downloadText(notesModal.content, `notes-${room.id}.md`);
  }

  function closeNotes() {
    setNotesModal({ open: false, content: '', loading: false });
  }

  function closeContext() {
    setContextModal({ open: false, md: '', paths: null, loading: false });
  }

  function leaveRoom() {
    if (socket) {
      socket.emit('room:leave');
      // hard reset
      socket.disconnect();
      socket = null;
    }
    setView('lobby');
    setRoom(null);
    setMessages([]);
    setParticipants({});
    setYourId('');
    setInput('');
    setTyping({});
    setGrokThinking(false);
    // clean url
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url.toString());
  }

  // Derived
  const participantList = Object.values(participants);
  const otherTyping = Object.entries(typing)
    .filter(([k, v]) => v && k !== yourId)
    .map(([k]) => {
      if (k === 'grok') return 'Grok';
      const p = participants[k];
      return p ? p.name : 'Someone';
    });

  const showGrokThinking = grokThinking || typing['grok'];

  const canSend = input.trim().length > 0 && !!room && !isSending;

  // Render
  if (view === 'lobby') {
    return (
      <div className="min-h-screen bg-bg flex flex-col">
        <div className="border-b border-border bg-bg-elev/80 backdrop-blur sticky top-0 z-10">
          <div className="max-w-3xl mx-auto px-6 h-16 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center">
                <MessageCircle className="w-5 h-5 text-black" />
              </div>
              <div>
                <div className="font-semibold tracking-tight text-xl">collab • grok</div>
                <div className="text-[10px] text-muted -mt-1">multi-persona real-time discussion</div>
              </div>
            </div>
            <div className="text-xs text-muted">up to 4 collaborators + Grok</div>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-md space-y-8">
            <div className="text-center space-y-2">
              <h1 className="text-4xl font-semibold tracking-tighter">Think together.</h1>
              <p className="text-muted text-lg">Real-time collab with friends and Grok.</p>
            </div>

            <div className="space-y-4 bg-bg-card border border-border rounded-2xl p-6">
              <div>
                <div className="text-sm font-medium mb-1.5">Your name</div>
                <input
                  value={myName}
                  onChange={(e) => setMyName(e.target.value)}
                  placeholder="Alex Rivera"
                  className="w-full bg-bg border border-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-accent/60"
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-1.5">Your persona / lens</div>
                <textarea
                  value={myPersona}
                  onChange={(e) => setMyPersona(e.target.value)}
                  rows={3}
                  className="w-full bg-bg border border-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-accent/60 resize-y"
                  placeholder="What perspective do you bring?"
                />
                <div className="text-[10px] text-muted mt-1">This helps everyone (and Grok) understand how you think.</div>
              </div>

              <div className="pt-2 grid grid-cols-1 gap-2">
                <button
                  onClick={createRoomAndJoin}
                  disabled={isJoining || !myName.trim()}
                  className="btn btn-primary w-full py-3 text-base disabled:opacity-60"
                >
                  <Plus className="w-4 h-4" /> Create new session
                </button>

                <div className="relative">
                  <div className="absolute inset-0 flex items-center px-3">
                    <div className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-[10px] uppercase tracking-widest text-muted bg-bg-card px-2">or</div>
                </div>

                <div className="flex gap-2">
                  <input
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="ROOMCODE"
                    className="flex-1 bg-bg border border-border rounded-xl px-4 py-2.5 text-sm font-mono tracking-[3px] focus:outline-none focus:border-accent/60"
                    onKeyDown={(e) => e.key === 'Enter' && handleJoinExisting()}
                  />
                  <button
                    onClick={handleJoinExisting}
                    disabled={isJoining || !joinCode.trim() || !myName.trim()}
                    className="btn btn-secondary px-5"
                  >
                    Join
                  </button>
                </div>
              </div>
            </div>

            <div className="text-center text-xs text-muted space-y-1">
              <div>Share the room code with 1–3 others.</div>
              <div>Grok joins as a thoughtful collaborator (it can stay quiet).</div>
              <div className="pt-1">For remote friends: run a tunnel (ngrok / cloudflared) on this machine.</div>
            </div>
          </div>
        </div>

        <div className="text-center pb-6 text-[10px] text-muted">
          API key stays on your server. Full history export + Grok-generated notes &amp; context packs.
        </div>
      </div>
    );
  }

  // CHAT VIEW
  const roomId = room?.id || '';
  const you = participants[yourId];

  return (
    <div className="h-screen flex flex-col bg-bg overflow-hidden">
      {/* Top bar */}
      <div className="h-14 border-b border-border bg-bg-elev/95 backdrop-blur z-20 flex items-center px-4 md:px-6 shrink-0">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center shrink-0">
              <MessageCircle className="w-4 h-4 text-black" />
            </div>
            <div className="font-semibold tracking-tight">collab</div>
          </div>

          <div className="flex items-center gap-2">
            <div
              onClick={() => {
                navigator.clipboard.writeText(roomId);
                toast.success('Room code copied');
              }}
              className="room-code cursor-pointer active:bg-bg flex items-center gap-1.5"
              title="Click to copy"
            >
              {roomId} <Copy className="w-3 h-3" />
            </div>
            <div className="text-xs px-2 py-0.5 rounded bg-bg-card border border-border text-muted hidden sm:block">
              {participantList.length}/4
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={summonGrok} className="btn btn-secondary text-xs px-3 py-1.5" title="Force Grok to respond now">
            <Brain className="w-3.5 h-3.5" /> Summon Grok
          </button>

          <button onClick={toggleGrokAuto} className="btn btn-ghost text-xs px-2.5 py-1.5 flex items-center gap-1.5" title="Toggle Grok auto participation">
            {grokAuto ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">Grok auto {grokAuto ? 'on' : 'off'}</span>
          </button>

          <button onClick={() => exportChat('md')} className="btn btn-ghost px-2.5 py-1.5" title="Export transcript">
            <Download className="w-4 h-4" />
          </button>

          <button onClick={buildNotes} className="btn btn-ghost px-2.5 py-1.5" title="Ask Grok to build structured notes">
            <FileText className="w-4 h-4" />
          </button>

          <button onClick={generateContextPack} className="btn btn-ghost px-2.5 py-1.5" title="Generate future-Grok catch-up context pack + JSON">
            <Brain className="w-4 h-4" />
          </button>

          <button onClick={leaveRoom} className="btn btn-ghost px-3 py-1.5 text-red-400 hover:bg-red-950/30">Leave</button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto chat-scroll px-4 md:px-6 pt-6 pb-4" style={{ background: 'radial-gradient(circle at 50% 0, #111 0%, #0a0a0a 70%)' }}>
            <div className="max-w-[1080px] mx-auto space-y-6">
              {messages.length === 0 && (
                <div className="text-center py-10 text-muted text-sm max-w-xs mx-auto">
                  Conversation started. Say hi and introduce your thinking.
                  <div className="mt-2 text-xs">Grok will listen and chime in only when it has something useful.</div>
                </div>
              )}

              {messages.map((m, idx) => {
              const isYou = m.userId === yourId && m.role !== 'grok';
              const isG = m.role === 'grok';
              const isSys = m.name === 'System';

              return (
                <div key={m.id + idx} className={cn('flex', isYou ? 'justify-end' : 'justify-start')}>
                  <div className={cn('max-w-[min(92%,_850px)]', isYou && 'items-end')}>
                    <div className="flex items-center gap-2 mb-1 px-1 text-[10px] text-muted">
                      <span className={cn('font-medium', isG && 'text-blue-400', isYou && 'text-white/70')}>
                        {isYou ? 'You' : m.name}
                      </span>
                      <span className="opacity-40">•</span>
                      <span>{format(new Date(m.ts), 'HH:mm')}</span>
                    </div>

                    <div
                      className={cn(
                        'message-bubble whitespace-pre-wrap break-words',
                        isYou ? 'user' : isG ? 'grok' : 'other',
                        isSys && 'bg-transparent border border-border/50 text-muted text-xs py-1 px-3'
                      )}
                    >
                      {m.content}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Live typing / thinking */}
            {(otherTyping.length > 0 || showGrokThinking) && (
              <div className="px-1">
                {otherTyping.length > 0 && (
                  <div className="typing-indicator">
                    {otherTyping.join(', ')} {otherTyping.length === 1 ? 'is' : 'are'} typing…
                  </div>
                )}
                {showGrokThinking && (
                  <div className="typing-indicator text-blue-400/80">
                    <span className="inline-block w-1.5 h-1.5 bg-current rounded-full animate-pulse" /> Grok is thinking…
                  </div>
                )}
              </div>
            )}

            <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input */}
          <div className="border-t border-border p-4 md:p-5 bg-bg-elev shrink-0">
            <div className="max-w-[1080px] mx-auto">
              <div className="input-area flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleInputKey}
                  placeholder="Type your thoughts… (Shift+Enter for newline)"
                  rows={1}
                  className="flex-1 bg-transparent resize-none outline-none text-[15px] max-h-[140px] py-2.5 px-3 placeholder:text-muted"
                  style={{ fieldSizing: 'content' as any }}
                />
                <button
                  onClick={sendMessage}
                  disabled={!canSend}
                  className="btn btn-primary h-10 w-10 p-0 rounded-2xl shrink-0"
                  title="Send (Enter)"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <div className="text-[10px] text-muted mt-1.5 px-1 flex justify-between">
                <div>
                  {you && <span>Your lens: <span className="text-accent/80">{you.persona.slice(0, 70)}{you.persona.length > 70 ? '…' : ''}</span></span>}
                </div>
                <div>Everyone sees when you or Grok are typing</div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-80 border-l border-border bg-bg-elev/50 p-4 overflow-y-auto hidden lg:flex flex-col gap-4 shrink-0">
          <div>
            <div className="uppercase text-xs tracking-[1px] text-muted mb-2 flex items-center gap-1.5 px-1">
              <Users className="w-3.5 h-3.5" /> COLLABORATORS
            </div>

            <div className="space-y-2">
              {participantList.length === 0 && (
                <div className="text-xs text-muted px-3 py-2">No one else yet. Share the room code.</div>
              )}
              {participantList.map((p) => {
                const isYou = p.id === yourId;
                const isEditing = editingPersonaFor === p.id;
                return (
                  <div key={p.id} className="participant-card">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium text-sm flex items-center gap-1.5">
                          {p.name}
                          {isYou && <span className="text-[10px] text-accent">(you)</span>}
                        </div>
                        <div className="text-xs text-muted mt-0.5 leading-snug pr-1">
                          {isEditing ? (
                            <div className="space-y-1">
                              <textarea
                                value={editPersonaText}
                                onChange={(e) => setEditPersonaText(e.target.value)}
                                className="w-full bg-bg text-xs rounded border border-border p-1.5"
                                rows={2}
                              />
                              <div className="flex gap-1">
                                <button onClick={savePersona} className="text-[10px] px-2 py-0.5 bg-accent text-black rounded">Save</button>
                                <button onClick={() => setEditingPersonaFor(null)} className="text-[10px] px-2 py-0.5">Cancel</button>
                              </div>
                            </div>
                          ) : (
                            p.persona
                          )}
                        </div>
                      </div>
                      {isYou && !isEditing && (
                        <button onClick={() => startEditPersona(p.id)} className="text-muted hover:text-white p-1 -mr-1">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {participantList.length < 4 && (
                <div className="text-[10px] text-muted/70 px-1 pt-1">Room can hold {4 - participantList.length} more.</div>
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-border mt-auto">
            <div className="text-xs uppercase tracking-widest text-muted mb-2 px-1">ACTIONS</div>
            <div className="grid grid-cols-1 gap-2 text-sm">
              <button onClick={() => exportChat('md')} className="btn btn-secondary justify-start text-left gap-2">
                <Download className="w-4 h-4" /> Export full conversation (.md)
              </button>
              <button onClick={buildNotes} className="btn btn-secondary justify-start text-left gap-2">
                <FileText className="w-4 h-4" /> Build structured notes (Grok)
              </button>
              <button onClick={generateContextPack} className="btn btn-secondary justify-start text-left gap-2">
                <Brain className="w-4 h-4" /> Generate catch-up context pack
              </button>
              <button onClick={summonGrok} className="btn btn-secondary justify-start text-left gap-2">
                <Brain className="w-4 h-4" /> Summon Grok now
              </button>
              <button onClick={leaveRoom} className="btn btn-ghost justify-start text-left text-red-400/90 hover:bg-red-950/20">
                <X className="w-4 h-4" /> Leave this session
              </button>
            </div>
            <div className="mt-4 text-[10px] text-muted/60 px-1 leading-snug">
              Context packs + notes are saved in <span className="font-mono">context-packs/</span> on the server machine.
            </div>
          </div>
        </div>
      </div>

      {/* Notes Modal */}
      {notesModal.open && (
        <div className="modal" onClick={closeNotes}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div className="font-medium flex items-center gap-2"><FileText className="w-4 h-4" /> Structured Notes</div>
              <button onClick={closeNotes} className="text-muted hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 overflow-auto flex-1 text-sm leading-relaxed whitespace-pre-wrap chat-scroll bg-[#0c0c0c]">
              {notesModal.loading ? (
                <div className="text-muted animate-pulse">Grok is synthesizing the discussion into clean notes…</div>
              ) : (
                notesModal.content
              )}
            </div>
            <div className="p-4 border-t border-border flex gap-2 justify-end bg-bg-elev">
              {!notesModal.loading && (
                <>
                  <button onClick={downloadNotes} className="btn btn-secondary">Download .md</button>
                  <button onClick={() => { navigator.clipboard.writeText(notesModal.content); toast.success('Copied notes'); }} className="btn btn-secondary">Copy</button>
                </>
              )}
              <button onClick={closeNotes} className="btn btn-primary">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Context Pack Modal */}
      {contextModal.open && (
        <div className="modal" onClick={closeContext}>
          <div className="modal-content max-w-3xl" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div className="font-medium flex items-center gap-2"><Brain className="w-4 h-4" /> Future-Grok Context Pack</div>
              <button onClick={closeContext} className="text-muted hover:text-white"><X /></button>
            </div>

            <div className="p-5 text-xs bg-black/30 font-mono text-muted border-b border-border">
              This file lets a future Grok instantly catch up on everything important.
            </div>

            <div className="p-5 overflow-auto flex-1 text-sm whitespace-pre-wrap chat-scroll bg-[#0c0c0c] leading-relaxed">
              {contextModal.loading ? 'Generating dense context + structured JSON…' : contextModal.md}
            </div>

            <div className="p-4 border-t border-border bg-bg-elev text-sm space-y-3">
              {contextModal.paths && (
                <div className="text-xs bg-bg-card border border-border rounded p-3 font-mono">
                  Saved on server:<br />
                  • {contextModal.paths.md}<br />
                  • {contextModal.paths.json}
                </div>
              )}
              <div className="flex gap-2 justify-end">
                {!contextModal.loading && contextModal.md && (
                  <button onClick={() => { navigator.clipboard.writeText(contextModal.md); toast.success('Copied'); }} className="btn btn-secondary">Copy MD</button>
                )}
                <button onClick={closeContext} className="btn btn-primary">Done</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
