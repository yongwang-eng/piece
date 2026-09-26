// Source 2: Granola meeting transcripts, read from the work_hub archive (~/.work_hub/data.db, read-only).
// A meeting is a session; each ~CHUNK-sized run of turns is an entry so both lanes see the tag header and
// `recall_show window` walks neighbouring blocks. Tags come from meetings.rules.json — a list, never a judgment.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { CHUNK, chunk } from "./extract.ts";

export type Rules = {
  recorder: string;
  series: { match: string; flags?: string; kind: string; series: string }[];
  sub: { match: string; flags?: string; sub: string; only_participants?: number }[];
  fallback: { "1": string; "2": string; "3+": string };
  header_names_max: number;
};
export const loadRules = (path = new URL("./meetings.rules.json", import.meta.url)): Rules => JSON.parse(readFileSync(path, "utf8"));

export type Meeting = { granola_uuid: string; title: string; date_iso: string | null; date_raw: string | null; participants: { name: string; email?: string }[]; summary: string | null; raw_text: string; captured_at: string };
export type Tag = { kind: string; series: string | null; sub: string | null; recurring: boolean };

export function tag(m: Pick<Meeting, "title" | "participants">, rules: Rules): Tag {
  const n = m.participants.length;
  const sub = rules.sub.find(r => (r.only_participants === undefined || r.only_participants === n) && new RegExp(r.match, r.flags).test(m.title))?.sub ?? null;
  const row = rules.series.find(r => new RegExp(r.match, r.flags).test(m.title));
  if (row) return { kind: row.kind, series: row.series, sub, recurring: true };
  const kind = n <= 1 ? rules.fallback["1"] : n === 2 ? (sub === "intro" ? "one_on_one" : rules.fallback["2"]) : rules.fallback["3+"];
  return { kind, series: null, sub, recurring: false };
}

// Granola labels the recorder's own mic "Microphone" and everyone else "System audio" (named when it can).
// Both substitutions are facts from the recording, not guesses: the recorder is Yong; in a 1:1 the other voice is the other participant.
export function speaker(label: string, m: Pick<Meeting, "participants">, t: Tag, rules: Rules): string {
  if (label === "Microphone") return rules.recorder;
  const named = /^System audio \((.+)\)$/.exec(label);
  if (named) return named[1];
  if (label === "System audio" && t.kind === "one_on_one" && m.participants.length === 2) {
    const other = m.participants.find(p => !p.name.startsWith(rules.recorder));
    if (other) return other.name;
  }
  return label;
}

const TURN = /^([^:\n]{1,60}):\s?([\s\S]*)$/;
export function turns(raw: string, m: Pick<Meeting, "participants">, t: Tag, rules: Rules): string[] {
  return raw.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).map(s => {
    const x = TURN.exec(s);
    return x ? `${speaker(x[1], m, t, rules)}: ${x[2]}` : s;
  });
}

export function header(m: Meeting, t: Tag, rules: Rules, part: string): string {
  const date = (m.date_iso ?? "").slice(0, 10);
  const tags = [t.kind, t.series, t.sub, t.recurring ? "recurring" : null, date].filter(Boolean).join(" · ");
  const names = m.participants.map(p => p.name).filter(n => !n.startsWith(rules.recorder));
  const withWho = names.length === 0 ? "" : names.length <= rules.header_names_max ? ` · with ${names.join(", ")}` : ` · ${m.participants.length} participants`;
  return `[${tags}] ${m.title}${withWho} · ${part}`;
}

// Pack whole turns into blocks of about CHUNK chars; a single longer turn stands alone and chunk() splits it.
export function blocks(ts: string[], target = CHUNK - 200): string[][] {
  const out: string[][] = []; let cur: string[] = [], len = 0;
  for (const t of ts) {
    if (cur.length && len + t.length + 2 > target) { out.push(cur); cur = []; len = 0; }
    cur.push(t); len += t.length + 2;
  }
  if (cur.length) out.push(cur);
  return out;
}

export type MeetingDoc = { key: string; entry_id: string; parent_id: string | null; line: number; kind: "meeting_turns" | "meeting_summary"; text: string };
export function meetingDocs(m: Meeting, rules: Rules): { tag: Tag; docs: MeetingDoc[] } {
  const t = tag(m, rules), ts = m.date_iso ?? m.captured_at;
  const docs: MeetingDoc[] = [];
  if (m.summary?.trim()) docs.push({ key: `${m.granola_uuid}#summary@${ts}`, entry_id: `${m.granola_uuid}#summary`, parent_id: null, line: 0, kind: "meeting_summary", text: `${header(m, t, rules, "Granola summary")}\n${m.summary.trim()}` });
  const bs = blocks(turns(m.raw_text, m, t, rules));
  bs.forEach((b, i) => {
    const id = `${m.granola_uuid}#b${String(i + 1).padStart(3, "0")}`;
    docs.push({ key: `${id}@${ts}`, entry_id: id, parent_id: i ? `${m.granola_uuid}#b${String(i).padStart(3, "0")}` : (docs[0]?.entry_id ?? null), line: i + 1, kind: "meeting_turns", text: `${header(m, t, rules, `part ${i + 1}/${bs.length}`)}\n${b.join("\n\n")}` });
  });
  return { tag: t, docs };
}

export type MeetingsResult = { meetings: number; entries: number; chunks: number; unchanged: number };
export const WORKHUB_PREFIX = "workhub:";

// Incremental: one `files` row per meeting keyed by captured_at; a re-archived meeting is replaced whole.
export function indexMeetings(db: DatabaseSync, workHubDb: string, rules: Rules = loadRules()): MeetingsResult {
  const res: MeetingsResult = { meetings: 0, entries: 0, chunks: 0, unchanged: 0 };
  let src: DatabaseSync;
  try { src = new DatabaseSync(workHubDb, { readOnly: true }); } catch { return res; }   // no archive on this machine: nothing to index
  const rows = src.prepare("SELECT granola_uuid, title, date_iso, date_raw, participants, summary, raw_text, captured_at FROM transcripts").all() as any[];
  src.close();
  const getFile = db.prepare("SELECT mtime, size FROM files WHERE path = ?");
  const putFile = db.prepare(`INSERT INTO files(path, session, cwd, byte_offset, line_count, size, mtime) VALUES (?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET session = excluded.session, cwd = excluded.cwd, line_count = excluded.line_count, size = excluded.size, mtime = excluded.mtime`);
  const putDoc = db.prepare(`INSERT INTO docs(key, entry_id, parent_id, session, cwd, file, line, ts, role, kind, tool, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'meeting', ?, NULL, ?)`);
  const putChunk = db.prepare("INSERT INTO chunks(key, ci, start, end, text) VALUES (?, ?, ?, ?, ?)");
  const delVecs = db.prepare("DELETE FROM vecs WHERE chunk_id IN (SELECT id FROM chunks WHERE key IN (SELECT key FROM docs WHERE session = ?))");
  const delChunks = db.prepare("DELETE FROM chunks WHERE key IN (SELECT key FROM docs WHERE session = ?)");
  const delDocs = db.prepare("DELETE FROM docs WHERE session = ?");
  for (const r of rows) {
    const path = WORKHUB_PREFIX + r.granola_uuid, mtime = Date.parse(r.captured_at) || 0, size = (r.raw_text ?? "").length + (r.summary ?? "").length;
    const prev = getFile.get(path) as { mtime: number; size: number } | undefined;
    if (prev && prev.mtime === mtime && prev.size === size) { res.unchanged++; continue; }
    const m: Meeting = { granola_uuid: r.granola_uuid, title: r.title, date_iso: r.date_iso, date_raw: r.date_raw, participants: JSON.parse(r.participants || "[]"), summary: r.summary, raw_text: r.raw_text ?? "", captured_at: r.captured_at };
    const { tag: t, docs } = meetingDocs(m, rules);
    const cwd = `meetings/${t.series ?? t.kind}`;
    db.exec("BEGIN");
    try {
      delVecs.run(m.granola_uuid); delChunks.run(m.granola_uuid); delDocs.run(m.granola_uuid);
      for (const d of docs) {
        putDoc.run(d.key, d.entry_id, d.parent_id, m.granola_uuid, cwd, path, d.line, m.date_iso ?? m.captured_at, d.kind, d.text);
        for (const c of chunk(d.text)) { putChunk.run(d.key, c.ci, c.start, c.end, c.text); res.chunks++; }
        res.entries++;
      }
      putFile.run(path, m.granola_uuid, cwd, docs.length, size, mtime);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    res.meetings++;
  }
  return res;
}
