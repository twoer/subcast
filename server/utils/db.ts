import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SUBCAST_HOME = join(homedir(), '.subcast');
const DB_PATH = join(SUBCAST_HOME, 'data.sqlite');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(SUBCAST_HOME, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        sha256          TEXT PRIMARY KEY,
        original_name   TEXT NOT NULL,
        ext             TEXT NOT NULL,
        size_bytes      INTEGER NOT NULL,
        duration_s      REAL,
        created_at      INTEGER NOT NULL,
        last_opened_at  INTEGER NOT NULL
      );
    `);
    db.pragma('user_version = 1');
  }
  if (version < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS subtitles (
        video_sha       TEXT NOT NULL REFERENCES videos(sha256),
        lang            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        cues_count      INTEGER NOT NULL,
        completed_at    INTEGER NOT NULL,
        PRIMARY KEY (video_sha, lang)
      );
    `);
    db.pragma('user_version = 2');
  }
}

export const SUBCAST_PATHS = {
  home: SUBCAST_HOME,
  videos: join(SUBCAST_HOME, 'videos'),
  cache: join(SUBCAST_HOME, 'cache'),
  logs: join(SUBCAST_HOME, 'logs'),
  tmp: join(SUBCAST_HOME, 'tmp'),
} as const;
