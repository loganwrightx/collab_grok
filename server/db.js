import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const DB_PATH = process.env.DB_PATH || './data/collab.db';
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    persona TEXT,
    password_hash TEXT NOT NULL,
    verified INTEGER DEFAULT 0,
    verification_code TEXT,
    verification_expires INTEGER,
    notify_on_activity INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    purpose TEXT,
    password_hash TEXT,
    created_by INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role_context TEXT,
    joined_at INTEGER DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (room_id, user_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id INTEGER,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
`);

// Helper to hash password for rooms (4-digit)
export function hashRoomPassword(pw) {
  if (!pw) return '';
  return crypto.createHash('sha256').update(pw).digest('hex');
}

// Users
export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function createUser({ email, name, persona, password }) {
  const password_hash = bcryptHash(password);
  const info = db.prepare(`
    INSERT INTO users (email, name, persona, password_hash, verified, notify_on_activity)
    VALUES (?, ?, ?, ?, 0, 1)
  `).run(email, name, persona || '', password_hash);
  return info.lastInsertRowid;
}

export function updateUser(id, { name, persona, notify_on_activity }) {
  if (notify_on_activity !== undefined) {
    db.prepare('UPDATE users SET name = ?, persona = ?, notify_on_activity = ? WHERE id = ?').run(name, persona, notify_on_activity, id);
  } else {
    db.prepare('UPDATE users SET name = ?, persona = ? WHERE id = ?').run(name, persona, id);
  }
}

export function setVerificationCode(email, code, expires) {
  db.prepare('UPDATE users SET verification_code = ?, verification_expires = ? WHERE email = ?')
    .run(code, expires, email);
}

export function verifyUser(email, code) {
  const user = getUserByEmail(email);
  if (!user || user.verified) return false;
  if (!user.verification_code || user.verification_code !== code) return false;
  if (user.verification_expires < Math.floor(Date.now() / 1000)) return false;
  db.prepare('UPDATE users SET verified = 1, verification_code = NULL, verification_expires = NULL WHERE email = ?').run(email);
  return true;
}

// Rooms
export function createRoom({ id, name, purpose, password, created_by }) {
  const password_hash = hashRoomPassword(password);
  db.prepare(`
    INSERT INTO rooms (id, name, purpose, password_hash, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, purpose, password_hash, created_by);
}

export function getRoomById(id) {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
}

export function getUserRooms(userId) {
  return db.prepare(`
    SELECT r.*, rm.role_context, rm.joined_at
    FROM rooms r
    JOIN room_members rm ON rm.room_id = r.id
    WHERE rm.user_id = ?
    ORDER BY rm.joined_at DESC
  `).all(userId);
}

export function addRoomMember(roomId, userId, roleContext = null) {
  db.prepare(`
    INSERT OR IGNORE INTO room_members (room_id, user_id, role_context)
    VALUES (?, ?, ?)
  `).run(roomId, userId, roleContext);
}

export function updateRoomMemberContext(roomId, userId, roleContext) {
  db.prepare('UPDATE room_members SET role_context = ? WHERE room_id = ? AND user_id = ?').run(roleContext, roomId, userId);
}

export function isRoomMember(roomId, userId) {
  const row = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, userId);
  return !!row;
}

export function getRoomMembers(roomId) {
  return db.prepare(`
    SELECT u.id, u.name, u.persona, u.email, u.notify_on_activity, rm.role_context
    FROM room_members rm
    JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = ?
  `).all(roomId);
}

export function deleteRoom(roomId, userId) {
  // Only creator can delete
  const room = getRoomById(roomId);
  if (!room || room.created_by !== userId) return false;
  db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
  return true;
}

// Messages
export function addMessage({ id, room_id, user_id, content, ts }) {
  db.prepare(`
    INSERT INTO messages (id, room_id, user_id, content, ts)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, room_id, user_id, content, ts);
}

export function getRecentMessages(roomId, limit = 200) {
  return db.prepare(`
    SELECT m.*, u.name as user_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.room_id = ?
    ORDER BY m.ts DESC
    LIMIT ?
  `).all(roomId, limit).reverse(); // oldest first
}

export function getOlderMessages(roomId, beforeTs, limit = 50) {
  return db.prepare(`
    SELECT m.*, u.name as user_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.room_id = ? AND m.ts < ?
    ORDER BY m.ts DESC
    LIMIT ?
  `).all(roomId, beforeTs, limit);
}

// Migration helper from old JSON (call on startup if needed)
export function migrateOldRooms() {
  const roomsDir = path.join(process.cwd(), 'data', 'rooms');
  if (!fs.existsSync(roomsDir)) return;
  const files = fs.readdirSync(roomsDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(roomsDir, file), 'utf8'));
      if (getRoomById(data.id)) continue; // already migrated
      createRoom({
        id: data.id,
        name: data.name || 'Untitled Chat',
        purpose: data.purpose || '',
        password: '', // old rooms no pw or handle
        created_by: null
      });
      // Could migrate messages and members but skip for simplicity, or implement if needed
      console.log(`[db] migrated old room ${data.id}`);
    } catch (e) {
      console.error('migrate error', e);
    }
  }
}

// Simple bcrypt helpers
function bcryptHash(pw) {
  return bcrypt.hashSync(pw, 10);
}

export function bcryptCompare(pw, hash) {
  return bcrypt.compareSync(pw, hash);
}

export function sendRoomUpdateEmail(to, roomName, fromName, snippet, roomId) {
  if (transporter) {  // transporter is in index, but for modularity pass or global
    // Note: transporter defined in index.js; for standalone, re-init or move
    console.log(`[EMAIL] Would send update to ${to} for room ${roomName}`);
    // In practice, call from index where transporter is
  } else {
    console.log(`[DEV] Room update for ${to}: New message in "${roomName}" from ${fromName}: ${snippet} (https://yourdomain.com/room/${roomId})`);
  }
}

export default db;
