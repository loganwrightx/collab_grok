export interface Participant {
  id: string;
  name: string;
  persona: string;
  joinedAt: number;
  color: string;
}

export interface Message {
  id: string;
  role: 'user' | 'grok';
  userId?: string; // for users
  name: string;
  content: string;
  ts: number;
}

export interface Room {
  id: string;
  createdAt: number;
  participants: Record<string, Participant>; // userId -> participant
  messages: Message[];
  summary: string; // running compaction of older history
  grokAuto: boolean;
  lastActivity: number;
  // For tracking
  grokThinking: boolean;
}

export interface ClientToServerEvents {
  'room:join': (data: { roomId: string; name: string; persona: string }) => void;
  'room:leave': () => void;
  'message:send': (content: string) => void;
  'typing:start': () => void;
  'typing:stop': () => void;
  'persona:update': (persona: string) => void;
  'grok:summon': () => void; // force grok to respond
  'room:toggle-grok-auto': (enabled: boolean) => void;
  'export:request': (format: 'json' | 'md') => void;
}

export interface ServerToClientEvents {
  'room:joined': (data: { room: RoomState; yourId: string }) => void;
  'room:updated': (data: { participants: Record<string, Participant>; grokAuto: boolean }) => void;
  'message:new': (msg: Message) => void;
  'messages:append': (msgs: Message[]) => void;
  'grok:thinking': (isThinking: boolean) => void;
  'typing:update': (typing: Record<string, boolean>) => void; // userId or 'grok' -> isTyping
  'error': (msg: string) => void;
  'system': (text: string) => void;
  'export:ready': (data: { format: string; content: string; filename: string }) => void;
}

export interface RoomState {
  id: string;
  createdAt: number;
  participants: Record<string, Participant>;
  messages: Message[];
  summary: string;
  grokAuto: boolean;
}
