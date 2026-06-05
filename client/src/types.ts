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
  userId?: string;
  name: string;
  content: string;
  ts: number;
}

export interface RoomState {
  id: string;
  createdAt: number;
  participants: Record<string, Participant>;
  messages: Message[];
  summary: string;
  grokAuto: boolean;
}

export interface TypingMap {
  [key: string]: boolean; // userId or 'grok'
}
