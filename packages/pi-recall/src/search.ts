// Rounds 2 + 4 — the read path. Two lanes always → GROUP BY entry (best chunk) → sibling merge → interleave with
// k PER LANE (dense first) → soft `since` tiers → chronological within the pack → header. Every call and every
// returned hit is logged (calls · provenance); every page is logged (shows). Nothing here writes to the index.
import type { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";
import { MODEL_ID, fromBlob } from "./embed.ts";

export const DEFAULT_K = 10, TOP_N = 100, MERGE_CAP = 4800, SHOW_TOKENS = 3000;
const STOP = new Set("the a an to of in on for did does do we it that this what how why when with was is are be by at and or from into after before because every all other its our you your they them their there here than then so not no yes about over under out up down got get".split(" "));

export type LaneHit = { key: string; score: number; chunk_id?: number; ci?: number; nHits?: number };
export type Hit = LaneHit & { rank: number; found_by: "lex" | "dense" | "both"; lex_rank: number | null; dense_rank: number | null; in_range: boolean | null;
  entry_id: string; session: string | null; cwd: string | null; project: string; file: string; line: number; ts: string; role: string; kind: string; tool: string | null; text: string; merged: boolean };

// ---- lex lane ----
export function lexQuery(q: string): string {
  const t = q.trim();
  if (!/\s/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  const toks = [...new Set(t.toLowerCase().match(/[a-z0-9_.\-]+/g) ?? [])].filter(w => w.length >= 3 && !STOP.has(w));
  return (toks.length ? toks : [t]).map(w => `"${w.replace(/"/g, '""')}"`).join(" OR ");
}
export function lexLane(db: DatabaseSync, query: string, topN = TOP_N): LaneHit[] {
  let rows: { id: number; key: string; ci: number; s: number }[] = [];
  try {
    rows = db.prepare(`SELECT c.id, c.key, c.ci, bm25(chunks_fts) s FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?`).all(lexQuery(query), topN * 3) as any;
  } catch { return []; }                                              // an unparseable query is an empty lane, not an error
  return groupByKey(rows.map(r => ({ key: r.key, score: -r.s, chunk_id: r.id, ci: r.ci })), topN);
}

// ---- dense lane: brute force over an in-memory matrix, appended incrementally as the index grows ----
export class VecIndex {
  ids: number[] = []; keys: string[] = []; cis: number[] = []; mat = new Float32Array(0); dim = 0; maxId = 0;
  db: DatabaseSync; modelId: string;
  constructor(db: DatabaseSync, modelId = MODEL_ID) { this.db = db; this.modelId = modelId; }
  refresh() {
    const rows = this.db.prepare(`SELECT v.chunk_id, v.emb, c.key, c.ci FROM vecs v JOIN chunks c ON c.id = v.chunk_id
      WHERE v.model_id = ? AND v.chunk_id > ? ORDER BY v.chunk_id`).all(this.modelId, this.maxId) as { chunk_id: number; emb: Uint8Array; key: string; ci: number }[];
    if (!rows.length) return;
    const first = fromBlob(rows[0].emb); this.dim ||= first.length;
    const next = new Float32Array(this.mat.length + rows.length * this.dim); next.set(this.mat);
    rows.forEach((r, i) => { next.set(fromBlob(r.emb), this.mat.length + i * this.dim); this.ids.push(r.chunk_id); this.keys.push(r.key); this.cis.push(r.ci); });
    this.mat = next; this.maxId = rows[rows.length - 1].chunk_id;
  }
  search(qv: Float32Array, topN = TOP_N): LaneHit[] {
    const n = this.ids.length, d = this.dim, sc = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; const o = i * d; for (let j = 0; j < d; j++) s += this.mat[o + j] * qv[j]; sc[i] = s; }
    const order = Array.from(sc.keys()).sort((a, b) => sc[b] - sc[a]).slice(0, topN * 3);
    return groupByKey(order.map(i => ({ key: this.keys[i], score: sc[i], chunk_id: this.ids[i], ci: this.cis[i] })), topN);
  }
}

// Round 2: the chunk gets the score, the entry gets the rank. nHits = chunks of this entry among the lane's top chunks.
export function groupByKey(chunks: LaneHit[], topN: number): LaneHit[] {
  const best = new Map<string, LaneHit>();
  for (const c of chunks) { const b = best.get(c.key); if (!b) best.set(c.key, { ...c, nHits: 1 }); else { b.nHits!++; if (c.score > b.score) Object.assign(b, { score: c.score, chunk_id: c.chunk_id, ci: c.ci, nHits: b.nHits }); } }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topN);
}

// Round 4: k per lane, dense first, a key already placed is skipped; found_by looks at each lane's top-N, not just its top-k.
export function interleaveK(dense: LaneHit[], lex: LaneHit[], k: number) {
  const dr = new Map(dense.map((h, i) => [h.key, i + 1])), lr = new Map(lex.map((h, i) => [h.key, i + 1]));
  const out: (LaneHit & { found_by: "lex" | "dense" | "both"; lex_rank: number | null; dense_rank: number | null })[] = [];
  const seen = new Set<string>();
  const place = (h: LaneHit) => {
    if (seen.has(h.key)) return; seen.add(h.key);
    const d = dr.get(h.key) ?? null, l = lr.get(h.key) ?? null;
    const src = d && l ? dense.find(x => x.key === h.key)! : h;
    out.push({ ...src, nHits: Math.max(h.nHits ?? 1, (d && l ? lex.find(x => x.key === h.key)?.nHits : 0) ?? 1), found_by: d && l ? "both" : d ? "dense" : "lex", dense_rank: d, lex_rank: l });
  };
  for (let i = 0; i < k; i++) { if (dense[i]) place(dense[i]); if (lex[i]) place(lex[i]); }
  return out;
}

// Round 4: `since` is a preference — in-range first (fused order kept), older ones follow, flagged; nothing dropped.
export function softSince<T extends { ts: string }>(hits: T[], since?: string): (T & { in_range: boolean | null })[] {
  if (!since) return hits.map(h => ({ ...h, in_range: null }));
  const inR = hits.filter(h => h.ts >= since), out = hits.filter(h => h.ts < since);
  return [...inR.map(h => ({ ...h, in_range: true })), ...out.map(h => ({ ...h, in_range: false }))];
}

// Round 4: chronological within each tier; the fused rank stays on the hit so the model still sees relevance.
export function chronoPack<T extends { ts: string; in_range: boolean | null }>(hits: T[]): T[] {
  const byTs = (a: T, b: T) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  return [...hits.filter(h => h.in_range !== false).sort(byTs), ...hits.filter(h => h.in_range === false).sort(byTs)];
}

// ---- assembling a hit's text: the best chunk, or (Round 2 sibling rule) a bounded span of the entry ----
type DocRow = { key: string; entry_id: string; parent_id: string | null; session: string | null; cwd: string | null; file: string; line: number; ts: string; role: string; kind: string; tool: string | null; text: string };
const docStmt = (db: DatabaseSync) => db.prepare("SELECT * FROM docs WHERE key = ?");
const chunkStmt = (db: DatabaseSync) => db.prepare("SELECT start, end FROM chunks WHERE id = ?");
export function hitText(db: DatabaseSync, doc: DocRow, chunk_id: number | undefined, merge: boolean): { text: string; merged: boolean } {
  const c = chunk_id ? (chunkStmt(db).get(chunk_id) as { start: number; end: number } | undefined) : undefined;
  if (!c) return { text: doc.text.slice(0, MERGE_CAP), merged: false };
  if (!merge || doc.text.length <= c.end - c.start) return { text: doc.text.slice(c.start, c.end), merged: false };
  const room = Math.max(0, MERGE_CAP - (c.end - c.start)), start = Math.max(0, c.start - Math.floor(room / 2));
  return { text: doc.text.slice(start, Math.min(doc.text.length, start + MERGE_CAP)), merged: true };
}
const project = (cwd: string | null) => (cwd ? basename(cwd) : "?");
const ago = (iso: string | null, now: string) => iso ? `${Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60000))} min ago` : "never";

// ---- the tool behind `recall` ----
export type RecallDeps = { embedQuery: (q: string) => Promise<Float32Array>; now?: () => string; toolCallId?: string; session?: string | null; cwd?: string | null; vecs?: VecIndex };
export async function recall(db: DatabaseSync, p: { query: string; since?: string; k?: number }, deps: RecallDeps) {
  const k = Math.max(1, Math.min(p.k ?? DEFAULT_K, 20)), now = deps.now?.() ?? new Date().toISOString();
  const t0 = performance.now(); const lex = lexLane(db, p.query); const lexMs = performance.now() - t0;
  const vecs = deps.vecs ?? new VecIndex(db); vecs.refresh();
  const t1 = performance.now(); const dense = vecs.dim ? vecs.search(await deps.embedQuery(p.query)) : []; const denseMs = performance.now() - t1;
  const fused = interleaveK(dense, lex, k).map((h, i) => ({ ...h, rank: i + 1 }));
  const get = docStmt(db);
  const hits: Hit[] = fused.map(h => {
    const d = get.get(h.key) as DocRow; const { text, merged } = hitText(db, d, h.chunk_id, (h.nHits ?? 1) >= 2);
    return { ...h, entry_id: d.entry_id, session: d.session, cwd: d.cwd, project: project(d.cwd), file: d.file, line: d.line, ts: d.ts, role: d.role, kind: d.kind, tool: d.tool, text, merged, in_range: null };
  });
  const pack = chronoPack(softSince(hits, p.since));
  const indexedThrough = (db.prepare("SELECT MAX(ts) t FROM docs").get() as any).t as string | null;
  const inRange = p.since ? pack.filter(h => h.in_range).length : null;
  const span = pack.length ? `spans ${pack[0].ts.slice(0, 16)} → ${pack.map(h => h.ts).sort().at(-1)!.slice(0, 16)} · later entries may supersede earlier ones` : "no hits";
  const nChunks = (db.prepare("SELECT COUNT(*) n FROM chunks").get() as any).n as number;
  const coverage = vecs.dim ? `${MODEL_ID.split("/")[1]} covers ${vecs.ids.length}/${nChunks} chunks` : "dense lane EMPTY — index not embedded yet";
  const header = `recall "${p.query}" · k=${k}/lane · ${pack.length} hits (dense ${dense.slice(0, k).length} · lex ${lex.slice(0, k).length} · both ${pack.filter(h => h.found_by === "both").length})` +
    (p.since ? ` · in range ${inRange}/${pack.length} (since ${p.since})` : "") +
    ` · indexed_through ${indexedThrough ?? "never"} (${ago(indexedThrough, now)}) · ${coverage} · ${span}`;
  if (deps.toolCallId) {
    db.exec("BEGIN");
    try {
      db.prepare(`INSERT OR REPLACE INTO calls(tool_call_id, ts, session, cwd, query, since, k, pack_size, in_range, indexed_through, model_id, lex_ms, dense_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(deps.toolCallId, now, deps.session ?? null, deps.cwd ?? null, p.query, p.since ?? null, k, pack.length, inRange, indexedThrough, vecs.dim ? MODEL_ID : null, lexMs, denseMs);
      const ins = db.prepare(`INSERT OR REPLACE INTO provenance(tool_call_id, rank, key, found_by, lex_rank, dense_rank, score, chunk_id, merged, in_range) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const h of pack) ins.run(deps.toolCallId, h.rank, h.key, h.found_by, h.lex_rank, h.dense_rank, h.score, h.chunk_id ?? null, h.merged ? 1 : 0, h.in_range === null ? null : h.in_range ? 1 : 0);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  return { header, hits: pack, lexMs, denseMs, indexedThrough };
}

// ---- the tool behind `recall_show`: entry · window(±n entries, same session) · exchange (user turn → next user turn) ----
export async function recallShow(db: DatabaseSync, p: { key: string; level?: "entry" | "window" | "exchange"; n?: number; max_tokens?: number; offset?: number }, deps: Pick<RecallDeps, "now" | "toolCallId" | "session">) {
  const level = p.level ?? "entry", n = p.n ?? 2, cap = (p.max_tokens ?? SHOW_TOKENS) * 4, now = deps.now?.() ?? new Date().toISOString();
  const doc = docStmt(db).get(p.key) as DocRow | undefined;
  if (!doc) return { text: `no entry with key ${p.key}`, entries: [], truncated: false };
  let entries: DocRow[];
  if (level === "entry") entries = [doc];
  else {
    const sess = db.prepare("SELECT * FROM docs WHERE session = ? ORDER BY ts, line").all(doc.session) as DocRow[];
    const i = sess.findIndex(d => d.key === doc.key);
    if (level === "window") entries = sess.slice(Math.max(0, i - n), i + n + 1);
    else {
      let s = i; while (s > 0 && sess[s].kind !== "user") s--;
      let e = i + 1; while (e < sess.length && sess[e].kind !== "user") e++;
      entries = sess.slice(s + (p.offset ?? 0), e);
    }
  }
  let used = 0, truncated = false; const shown: (DocRow & { shown: string })[] = [];
  for (const d of entries) {
    if (used >= cap) { truncated = true; break; }
    const t = d.text.length + used > cap ? d.text.slice(0, cap - used) + " …" : d.text;
    if (t.length < d.text.length) truncated = true;
    used += t.length; shown.push({ ...d, shown: t });
  }
  const text = shown.map(d => `— [${d.entry_id}@${d.ts.slice(0, 19)}] ${d.role}${d.tool ? `(${d.tool})` : ""} · ${project(d.cwd)} · ${basename(d.file)}:${d.line}\n${d.shown}`).join("\n\n") +
    (truncated ? `\n\n… truncated at ${p.max_tokens ?? SHOW_TOKENS} tokens (${entries.length - shown.length} more entries; pass offset/max_tokens to continue)` : "");
  if (deps.toolCallId) db.prepare(`INSERT OR REPLACE INTO shows(tool_call_id, ts, session, key, level, n, max_tokens, returned_chars) VALUES (?,?,?,?,?,?,?,?)`)
    .run(deps.toolCallId, now, deps.session ?? null, p.key, level, n, p.max_tokens ?? SHOW_TOKENS, text.length);
  return { text, entries: shown, truncated };
}
