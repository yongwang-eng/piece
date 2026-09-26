// The one SQLite file behind pi-recall. Everything here is derived from pi's session JSONL and rebuildable,
// except the eval record (calls · shows · provenance · judgments), which pi cannot reconstruct once ranks change.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, session TEXT, cwd TEXT,
  byte_offset INTEGER NOT NULL DEFAULT 0, line_count INTEGER NOT NULL DEFAULT 0, size INTEGER, mtime REAL
);
CREATE TABLE IF NOT EXISTS docs (
  key TEXT PRIMARY KEY,               -- "<entry id>@<entry timestamp>": fork copies share both, unrelated entries never do
  entry_id TEXT NOT NULL, parent_id TEXT, session TEXT, cwd TEXT, file TEXT, line INTEGER,
  ts TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, tool TEXT, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_ts ON docs(ts);
CREATE INDEX IF NOT EXISTS docs_session ON docs(session, ts);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL REFERENCES docs(key), ci INTEGER NOT NULL,
  start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_key ON chunks(key);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize="unicode61 tokenchars '-_.'");
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS vecs (
  chunk_id INTEGER NOT NULL REFERENCES chunks(id), model_id TEXT NOT NULL, emb BLOB NOT NULL,
  PRIMARY KEY (chunk_id, model_id)
);
-- eval record (the exception to "store nothing pi has"): one row per call, per page, per returned hit, per judgment
CREATE TABLE IF NOT EXISTS calls (
  tool_call_id TEXT PRIMARY KEY, ts TEXT NOT NULL, session TEXT, cwd TEXT,
  query TEXT NOT NULL, since TEXT, k INTEGER, pack_size INTEGER, in_range INTEGER,
  indexed_through TEXT, model_id TEXT, lex_ms REAL, dense_ms REAL
);
CREATE TABLE IF NOT EXISTS provenance (
  tool_call_id TEXT NOT NULL REFERENCES calls(tool_call_id), rank INTEGER NOT NULL, key TEXT NOT NULL,
  found_by TEXT NOT NULL, lex_rank INTEGER, dense_rank INTEGER, score REAL, chunk_id INTEGER, merged INTEGER, in_range INTEGER,
  PRIMARY KEY (tool_call_id, rank)
);
CREATE TABLE IF NOT EXISTS shows (
  tool_call_id TEXT PRIMARY KEY, ts TEXT NOT NULL, session TEXT, key TEXT NOT NULL, level TEXT NOT NULL, n INTEGER, max_tokens INTEGER, returned_chars INTEGER
);
CREATE TABLE IF NOT EXISTS judgments (
  tool_call_id TEXT NOT NULL, key TEXT NOT NULL, verdict TEXT NOT NULL, evidence TEXT, judge_model TEXT, ts TEXT NOT NULL,
  PRIMARY KEY (tool_call_id, key)
);
`;

export function openStore(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

// Rebuild drops only what is derived; the eval record survives because its keys still name real entries.
export function dropDerived(db: DatabaseSync): void {
  db.exec("DELETE FROM vecs; DELETE FROM chunks; DELETE FROM docs; DELETE FROM files;");
}
