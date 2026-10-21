import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {installSyncSchema} from './sync.mjs';
import {installServerSchema} from './server-schema.mjs';
import {installGpuHistorySchema} from './gpu-history.mjs';

export function openDatabase(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'lab-chat.sqlite'));
  if(db.prepare('PRAGMA user_version').get().user_version>8){db.close();throw new Error('Database schema is newer than this application.');}
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      handle TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'member',
      identity_provider TEXT NOT NULL DEFAULT 'local', external_subject TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS external_identity ON users(identity_provider,external_subject) WHERE external_subject IS NOT NULL;
    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY, email TEXT, created_by TEXT NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK(kind IN ('public','private','dm')), dm_key TEXT UNIQUE,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS channel_name ON channels(name) WHERE kind != 'dm';
    CREATE TABLE IF NOT EXISTS memberships (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(channel_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL REFERENCES channels(id),
      user_id TEXT NOT NULL REFERENCES users(id), parent_id INTEGER REFERENCES messages(id),
      body TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), edited_at TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id,id);
    CREATE INDEX IF NOT EXISTS messages_parent ON messages(parent_id,id);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE, size INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reactions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), emoji TEXT NOT NULL,
      PRIMARY KEY(message_id,user_id,emoji)
    );
    CREATE TABLE IF NOT EXISTS mentions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(message_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL,
      target_id TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS gpu_observations (
      id TEXT PRIMARY KEY, stable TEXT NOT NULL, candidate TEXT NOT NULL,
      candidate_since INTEGER NOT NULL, candidate_sample REAL
    );
    CREATE TABLE IF NOT EXISTS user_login_names (
      login_name TEXT PRIMARY KEY COLLATE NOCASE,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS research_resources (
      id TEXT PRIMARY KEY, host TEXT NOT NULL, gpu_index INTEGER NOT NULL,
      label TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', owner_id TEXT REFERENCES users(id),
      enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(host,gpu_index)
    );
    CREATE TABLE IF NOT EXISTS resource_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, resource_id TEXT NOT NULL REFERENCES research_resources(id),
      user_id TEXT NOT NULL REFERENCES users(id), project TEXT NOT NULL, purpose TEXT NOT NULL,
      starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL CHECK(ends_at>starts_at),
      memory_gib REAL, status TEXT NOT NULL CHECK(status IN ('pending','reviewing','approved','allocated','rejected','cancelled','completed','expired')),
      version INTEGER NOT NULL DEFAULT 1, start_notified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reservations_resource_time ON resource_reservations(resource_id,starts_at,ends_at,status);
    CREATE TABLE IF NOT EXISTS reservation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reservation_id INTEGER NOT NULL REFERENCES resource_reservations(id),
      actor_id TEXT REFERENCES users(id), action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resource_balances (
      provider TEXT PRIMARY KEY CHECK(provider IN ('openai','anthropic','google')),
      amount REAL NOT NULL CHECK(amount>=0), currency TEXT NOT NULL CHECK(currency IN ('USD','KRW')),
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL REFERENCES users(id), version INTEGER NOT NULL DEFAULT 1
    );
  `);
  transaction(db,()=>{installSyncSchema(db);installGpuHistorySchema(db);installServerSchema(db);db.exec('PRAGMA user_version=8');});
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export const publicUser = user => ({ id:user.id, name:user.name, handle:user.handle, role:user.role });

export function createUser(db, { email, name, passwordHash = null, role = 'member', provider = 'local' }) {
  const id = randomUUID();
  const handle = `${email.split('@')[0].replace(/[^a-z0-9_-]/gi,'').slice(0,20) || 'member'}-${id.slice(0,4)}`;
  db.prepare('INSERT INTO users (id,email,name,handle,password_hash,role,identity_provider) VALUES (?,?,?,?,?,?,?)')
    .run(id,email,name,handle,passwordHash,role,provider);
  db.prepare("INSERT INTO memberships (channel_id,user_id) SELECT id,? FROM channels WHERE kind='public'").run(id);
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}

export function createChannel(db, { name, topic = '', kind = 'public', creator, members = [], dmKey = null }) {
  const id = randomUUID();
  db.prepare('INSERT INTO channels (id,name,topic,kind,created_by,dm_key) VALUES (?,?,?,?,?,?)').run(id,name,topic,kind,creator,dmKey);
  const users = kind === 'public' ? db.prepare("SELECT id FROM users WHERE identity_provider!='system'").all().map(u=>u.id) : [...new Set([creator,...members])];
  const insert = db.prepare('INSERT INTO memberships (channel_id,user_id) VALUES (?,?)');
  for (const user of users) insert.run(id,user);
  return id;
}

export function seedDemo(db) {
  if (db.prepare('SELECT count(*) AS n FROM users').get().n) return;
  transaction(db, () => {
    const people = [['지민','jimin','admin'],['서연','seoyeon','member'],['도윤','doyun','member']].map(([name,handle,role]) => {
      const user = createUser(db, {email:`${handle}@example.test`,name,role,provider:'demo'});
      db.prepare('UPDATE users SET handle=? WHERE id=?').run(handle,user.id);
      return user;
    });
    const general = createChannel(db,{name:'연구실-라운지',topic:'작은 발견부터 오늘의 소식까지. 연구실의 모든 대화가 시작되는 곳',creator:people[0].id});
    const papers = createChannel(db,{name:'논문-리딩',topic:'읽고, 질문하고, 함께 이해하기',creator:people[0].id});
    createChannel(db,{name:'실험-로그',topic:'실험 설정, 결과, 재현 방법을 기록합니다',creator:people[0].id});
    createChannel(db,{name:'공지사항',topic:'세미나 일정과 연구실 공지',creator:people[0].id});
    const insert=db.prepare('INSERT INTO messages (channel_id,user_id,body,parent_id,created_at) VALUES (?,?,?,?,?)');
    const sample=[
      [0,'새로운 연구실 공간에 오신 걸 환영해요 👋\n프로젝트 이야기는 채널에, 이어지는 질문은 스레드에 남겨 주세요. 기록이 쌓일수록 다음 연구가 쉬워집니다.'],
      [1,'이번 주 리딩 자료를 #논문-리딩 에 정리해 뒀어요.\n각자 궁금한 점 하나씩 가져오면 좋겠습니다 📚'],
      [2,'실험 재현 스크립트 정리가 끝났습니다. 설정과 결과는 #실험-로그 에 공유할게요.'],
      [0,'오늘의 작은 목표: 결과뿐 아니라 과정을 남기기.\n실패한 실험도 다음 사람에게는 좋은 출발점이 될 수 있어요 🌱']
    ];
    sample.forEach(([person,body],i)=>insert.run(general,people[person].id,body,null,new Date(Date.now()-(5-i)*3600000).toISOString()));
    insert.run(general,people[2].id,'좋아요! 실행 환경과 seed도 같이 기록해 둘게요.',4,new Date(Date.now()-1800000).toISOString());
    db.prepare('UPDATE messages SET pinned=1 WHERE id=1').run();
    db.prepare('INSERT INTO reactions VALUES (1,?,?)').run(people[1].id,'🌱');
    db.prepare('INSERT INTO reactions VALUES (1,?,?)').run(people[2].id,'🌱');
    insert.run(papers,people[1].id,'이번 주 리딩 질문\n1. 기존 접근과 비교해 가장 중요한 가정은 무엇인가요?\n2. 우리 데이터에서도 같은 결과를 기대할 수 있을까요?',null,new Date().toISOString());
  });
}
