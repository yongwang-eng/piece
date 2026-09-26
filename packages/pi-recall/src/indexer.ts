// Round 5 — the write path. Tail every session file from its byte cursor, index only complete lines,
// and commit rows + cursor in ONE transaction per file: a cursor ahead of its rows lies, behind them double-indexes.
import { DatabaseSync } from "node:sqlite";
import { openSync, readSync, closeSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extract, chunk } from "./extract.ts";
import { dropDerived } from "./store.ts";

export type IndexResult = { files: number; entries: number; chunks: number; skipped: number };

export function listSessionFiles(root: string): string[] {
  const out: string[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(root, d.name))) if (f.endsWith(".jsonl")) out.push(join(root, d.name, f));
  }
  return out.sort();
}

export function indexTail(db: DatabaseSync, root: string, opts: { rebuild?: boolean } = {}): IndexResult {
  if (opts.rebuild) dropDerived(db);
  const res: IndexResult = { files: 0, entries: 0, chunks: 0, skipped: 0 };
  const getFile = db.prepare("SELECT session, cwd, byte_offset, line_count FROM files WHERE path = ?");
  const putFile = db.prepare(`INSERT INTO files(path, session, cwd, byte_offset, line_count, size, mtime) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET session = excluded.session, cwd = excluded.cwd, byte_offset = excluded.byte_offset,
    line_count = excluded.line_count, size = excluded.size, mtime = excluded.mtime`);
  const putDoc = db.prepare(`INSERT OR IGNORE INTO docs(key, entry_id, parent_id, session, cwd, file, line, ts, role, kind, tool, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const putChunk = db.prepare("INSERT INTO chunks(key, ci, start, end, text) VALUES (?, ?, ?, ?, ?)");

  for (const path of listSessionFiles(root)) {
    const st = statSync(path);
    const prev = getFile.get(path) as { session: string | null; cwd: string | null; byte_offset: number; line_count: number } | undefined;
    let offset = prev?.byte_offset ?? 0, lines = prev?.line_count ?? 0;
    let session = prev?.session ?? null, cwd = prev?.cwd ?? null;
    if (st.size < offset) { offset = 0; lines = 0; }                 // truncated or replaced: start over
    if (st.size === offset) continue;

    const buf = Buffer.alloc(st.size - offset);
    const fd = openSync(path, "r");
    try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) continue;                                       // nothing complete yet
    const complete = buf.subarray(0, lastNl + 1).toString("utf8");

    db.exec("BEGIN");
    try {
      for (const raw of complete.split("\n")) {
        if (!raw) continue;
        lines++;
        let e: any; try { e = JSON.parse(raw); } catch { res.skipped++; continue; }
        if (e?.type === "session") { session = e.id ?? session; cwd = e.cwd ?? cwd; continue; }
        const doc = extract(e);
        if (!doc) { res.skipped++; continue; }
        const r = putDoc.run(doc.key, doc.entry_id, doc.parent_id, session, cwd, path, lines, doc.ts, doc.role, doc.kind, doc.tool, doc.text);
        if (r.changes === 0) { res.skipped++; continue; }             // a fork's copy of an entry already indexed
        res.entries++;
        for (const c of chunk(doc.text)) { putChunk.run(doc.key, c.ci, c.start, c.end, c.text); res.chunks++; }
      }
      putFile.run(path, session, cwd, offset + lastNl + 1, lines, st.size, st.mtimeMs);
      db.exec("COMMIT");
    } catch (err) { db.exec("ROLLBACK"); throw err; }
    res.files++;
  }
  return res;
}

export function indexedThrough(db: DatabaseSync): string | null {
  return (db.prepare("SELECT MAX(ts) t FROM docs").get() as { t: string | null }).t;
}
