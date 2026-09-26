import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.ts";
import { indexTail } from "./indexer.ts";
import { toBlob, MODEL_ID } from "./embed.ts";
import { interleaveK, softSince, chronoPack, lexQuery, recall, recallShow } from "./search.ts";

const h = (key, ts) => ({ key, ts });

test("interleaveK: dense first, each lane keeps its top-k, dupes collapse, found_by carries both ranks", () => {
  const dense = ["a", "b", "c", "d"].map((k, i) => ({ key: k, score: 1 - i / 10 }));
  const lex = ["c", "e", "a", "f"].map((k, i) => ({ key: k, score: 9 - i }));
  const out = interleaveK(dense, lex, 3);
  assert.deepEqual(out.map(o => o.key), ["a", "c", "b", "e"]);
  assert.deepEqual(out.map(o => o.found_by), ["both", "both", "dense", "lex"]);
  assert.deepEqual(out.map(o => [o.dense_rank, o.lex_rank]), [[1, 3], [3, 1], [2, null], [null, 2]]);
  assert.ok(out.length <= 6, "never more than 2k");
});

test("softSince: in-range hits first in fused order, older ones follow flagged, no hit dropped", () => {
  const hits = [h("old1", "2026-09-10T00:00:00Z"), h("new1", "2026-09-17T00:00:00Z"), h("old2", "2026-09-12T00:00:00Z"), h("new2", "2026-09-16T00:00:00Z")];
  const out = softSince(hits, "2026-09-15");
  assert.deepEqual(out.map(o => o.key), ["new1", "new2", "old1", "old2"]);
  assert.deepEqual(out.map(o => o.in_range), [true, true, false, false]);
  assert.deepEqual(softSince(hits, undefined).map(o => o.in_range), [null, null, null, null]);
});

test("chronoPack: chronological within each tier, the fused rank travels with the hit", () => {
  const tier = [h("b", "2026-09-13T01:21:00Z"), h("a", "2026-09-12T23:46:00Z"), h("c", "2026-09-14T00:00:00Z")].map((x, i) => ({ ...x, rank: i + 1, in_range: true }));
  const older = [{ ...h("z", "2026-09-01T00:00:00Z"), rank: 4, in_range: false }];
  const out = chronoPack([...tier, ...older]);
  assert.deepEqual(out.map(o => [o.key, o.rank]), [["a", 2], ["b", 1], ["c", 3], ["z", 4]]);
});

test("lexQuery: a bare token is a phrase, a question is an OR of its content words, a hyphenated name stays whole", () => {
  assert.equal(lexQuery("85462"), '"85462"');
  assert.equal(lexQuery("pi-background-compact"), '"pi-background-compact"');
  assert.equal(lexQuery("why does a reload after a prompt change cost so much"), '"reload" OR "prompt" OR "change" OR "cost" OR "much"');
});

// ---- end to end on a fixture, with a stub embedder so the dense lane is deterministic ----
const line = o => JSON.stringify(o) + "\n";
const T = i => `2026-09-18T10:00:${String(i).padStart(2, "0")}.000Z`;
const msg = (i, role, text, extra = {}) => line({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: T(i), message: { role, content: [{ type: "text", text }], ...extra } });
const unit = a => { const n = Math.hypot(...a); return Float32Array.from(a.map(x => x / n)); };
const stubVec = t => unit(/killed/i.test(t) ? [1, 0.1, 0] : /reload/i.test(t) ? [0.1, 1, 0] : [0, 0, 1]);

function fixtureDb() {
  const root = mkdtempSync(join(tmpdir(), "pi-recall-search-")); mkdirSync(join(root, "--proj"));
  writeFileSync(join(root, "--proj", "s.jsonl"), [
    line({ type: "session", version: 3, id: "sess", timestamp: T(0), cwd: "/Users/me/proj_x" }),
    msg(1, "user", "how do we tell every other pi session to reload"),
    msg(2, "assistant", "Yes — 12 of 13 reloaded; pid 85462 never joined the room."),
    msg(3, "toolResult", ("Killed: 9 — node subprocess died instantly. ").repeat(150), { toolCallId: "t", toolName: "bash" }),
    msg(4, "user", "unrelated: what is for lunch"),
    msg(5, "assistant", "the reload cost is 1.25× fresh after a prompt change"),
  ].join(""));
  const db = openStore(":memory:");
  indexTail(db, root);
  const ins = db.prepare("INSERT INTO vecs(chunk_id, model_id, emb) VALUES (?, ?, ?)");
  for (const c of db.prepare("SELECT id, text FROM chunks").all()) ins.run(c.id, MODEL_ID, toBlob(stubVec(c.text)));
  return db;
}
const deps = { embedQuery: async q => stubVec(q), now: () => "2026-09-18T10:05:00.000Z" };

test("recall: identifier found by lex, question found by dense, header + provenance + call row written", async () => {
  const db = fixtureDb();
  const r = await recall(db, { query: "85462", k: 5 }, { ...deps, toolCallId: "call-1", session: "caller", cwd: "/x" });
  const asst = r.hits.find(x => /85462/.test(x.text));
  assert.ok(asst, "the assistant entry is in the pack");
  assert.ok(asst.lex_rank === 1, `lex rank 1, got ${asst.lex_rank}`);
  assert.match(r.header, /indexed_through 2026-09-18T10:00:05/);
  assert.match(r.header, /spans/);
  assert.equal(db.prepare("SELECT query, k, pack_size FROM calls WHERE tool_call_id = 'call-1'").get().query, "85462");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM provenance WHERE tool_call_id = 'call-1'").get().n, r.hits.length);

  const q = await recall(db, { query: "the subprocess that got killed", k: 3 }, { ...deps, toolCallId: "call-2" });
  const tool = q.hits.find(x => x.kind === "tool_output");
  assert.ok(tool && tool.dense_rank === 1, "dense lane ranks the tool output first");
  assert.equal(tool.merged, true, "≥ 2 of its chunks hit → the entry comes back merged");
  assert.ok(tool.text.length > 1200 && tool.text.length <= 4800, `merged text is bounded, got ${tool.text.length}`);
});

test("recall_show: entry · window(±n) · exchange, each capped and logged", async () => {
  const db = fixtureDb();
  const key = db.prepare("SELECT key FROM docs WHERE entry_id = 'e2'").get().key;
  const e = await recallShow(db, { key, level: "entry" }, { ...deps, toolCallId: "show-1" });
  assert.match(e.text, /never joined the room/);
  const w = await recallShow(db, { key, level: "window", n: 1 }, { ...deps, toolCallId: "show-2" });
  assert.deepEqual(w.entries.map(x => x.entry_id), ["e1", "e2", "e3"]);
  const x = await recallShow(db, { key, level: "exchange", max_tokens: 200 }, { ...deps, toolCallId: "show-3" });
  assert.deepEqual(x.entries.map(x => x.entry_id).slice(0, 2), ["e1", "e2"], "exchange starts at the user turn");
  assert.ok(x.truncated, "200 tokens cannot hold the 6 000-char tool output → truncated flag");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM shows").get().n, 3);
});
