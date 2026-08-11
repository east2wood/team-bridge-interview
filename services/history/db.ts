import { join } from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { child } from '../logger'

const log = child('db')

let db: Database.Database | null = null

const MIGRATIONS: string[] = [
  // 1
  `
  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    source      TEXT NOT NULL,
    language    TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    incomplete  INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE segments (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    channel    TEXT NOT NULL,
    text       TEXT NOT NULL,
    start_ms   INTEGER NOT NULL,
    end_ms     INTEGER NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    language   TEXT
  );

  CREATE INDEX idx_segments_session ON segments(session_id, start_ms);
  CREATE INDEX idx_sessions_started ON sessions(started_at DESC);

  -- Full-text index over segment text, kept in sync by triggers so search
  -- can never drift from the transcript.
  CREATE VIRTUAL TABLE segments_fts USING fts5(
    text,
    content='segments',
    content_rowid='rowid'
  );

  CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
    INSERT INTO segments_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
    INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
    INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO segments_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  `,
]

export function openDatabase(): Database.Database {
  if (db) return db

  const file = join(app.getPath('userData'), 'teambridge.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL') // survives a hard kill mid-write
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')

  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    log.info({ from: v, to: v + 1 }, 'applying migration')
    db.exec(MIGRATIONS[v]!)
    db.pragma(`user_version = ${v + 1}`)
  }

  log.info({ file, version: MIGRATIONS.length }, 'database ready')
  return db
}

export function closeDatabase(): void {
  db?.close()
  db = null
}
