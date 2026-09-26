import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.ts";
import { indexTail, indexedThrough } from "./indexer.ts";

const line = o => JSON.stringify(o) + "\n";
const T = i => `2026-09-18T10:00:${String(i).padStart(2, "0")}.000Z`;
const entry = (i, type, extra) => ({ type, id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: T(i), ...extra });
const msg = (i, role, content, extra = {}) => entry(i, "message", { message: { role, content, ...extra } });

// Session A: every line type pi writes, in one file.
const A = [
  line({ type: "session", version: 3, id: "sess-a", timestamp: T(0), cwd: "/Users/me/proj" }),
  line(entry(0, "model_change", { provider: "anthropic", modelId: "m" })),
  line(msg(1, "user", [{ type: "text", text: "how do we tell every other pi session to reload" }])),
  line(msg(2, "assistant", [
    { type: "thinking", thinking: "SECRET-THOUGHT the wrong answer is 0.50" },
    { type: "text", text: "Yes — 12 of 13 reloaded; the orphan never joined the room." },
    { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "kill -0 85462" } },
  ])),
  line(msg(3, "toolResult", [{ type: "text", text: "Killed: 9 " + "x".repeat(6000) }, { type: "image", data: "AAAA" }], { toolCallId: "tc1", toolName: "bash" })),
  line(entry(4, "compaction", { summary: "SUMMARY-ONLY-TEXT of everything before", firstKeptEntryId: "e1", tokensBefore: 1 })),
  line(entry(5, "custom", { customType: "thought-trail", data: { digest: "DIGEST-ONLY-TEXT" } })),
  line(entry(6, "custom_message", { customType: "room_message", content: "[report from reviewer] the PR looks fine" })),
].join("");

// Session B: a fork — copies A's e1..e3 (same id + timestamp), adds one entry, ends mid-line (pi is still writing).
const B = [
  line({ type: "session", version: 3, id: "sess-b", timestamp: T(10), cwd: "/Users/me/proj" }),
  line(msg(1, "user", [{ type: "text", text: "how do we tell every other pi session to reload" }])),
  line(msg(2, "assistant", [{ type: "text", text: "Yes — 12 of 13 reloaded; the orphan never joined the room." }])),
  line(msg(3, "toolResult", [{ type: "text", text: "Killed: 9 " + "x".repeat(6000) }], { toolCallId: "tc1", toolName: "bash" })),
  line(msg(11, "user", "plain string content also counts")),
  JSON.stringify(msg(12, "assistant", [{ type: "text", text: "PARTIAL-LINE not yet flushed" }])), // no trailing newline
].join("");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-recall-sessions-"));
  mkdirSync(join(root, "--Users-yong-proj"));
  writeFileSync(join(root, "--Users-yong-proj", "a.jsonl"), A);
  writeFileSync(join(root, "--Users-yong-proj", "b.jsonl"), B);
  return root;
}

test("indexes what the model saw, dedupes fork copies, skips bookkeeping and the partial line", () => {
  const root = fixture();
  const db = openStore(":memory:");
  const r = indexTail(db, root);

  const docs = db.prepare("SELECT key, role, kind, text, session, cwd, line FROM docs ORDER BY ts, session").all();
  // A: user, assistant, toolResult, custom_message = 4 · B adds e11 only (e1–e3 are copies; e12 is partial)
  assert.equal(docs.length, 5, JSON.stringify(docs.map(d => [d.key, d.session])));
  assert.deepEqual(new Set(docs.map(d => d.kind)), new Set(["user", "assistant", "tool_output", "system"]));
  assert.equal(r.entries, 5);

  const asst = docs.find(d => d.role === "assistant");
  assert.match(asst.text, /never joined the room/);
  assert.match(asst.text, /bash .*kill -0 85462/, "toolCall args are part of the assistant entry");
  assert.doesNotMatch(asst.text, /SECRET-THOUGHT/, "thinking is not indexed");
  assert.equal(asst.session, "sess-a"); assert.equal(asst.cwd, "/Users/me/proj"); assert.equal(asst.line, 4);

  const all = docs.map(d => d.text).join("\n");
  assert.doesNotMatch(all, /SUMMARY-ONLY-TEXT/, "compaction summaries are derivations");
  assert.doesNotMatch(all, /DIGEST-ONLY-TEXT/, "custom entries are bookkeeping");
  assert.match(all, /report from reviewer/, "custom_message participates in LLM context → indexed");
  assert.doesNotMatch(all, /PARTIAL-LINE/, "a line without its newline is not complete");

  const tool = docs.find(d => d.kind === "tool_output");
  assert.match(tool.text, /\[image\]/, "image blocks collapse to a marker");
  const nChunks = db.prepare("SELECT COUNT(*) n FROM chunks WHERE key = ?").get(tool.key).n;
  assert.ok(nChunks >= 5, `6 000-char tool output → ≥ 5 chunks, no MAXCH cap (got ${nChunks})`);

  const hit = db.prepare(`SELECT c.key FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH '"85462"'`).all();
  assert.deepEqual(hit.map(h => h.key), [asst.key], "FTS finds the identifier in the assistant entry");

  assert.equal(indexedThrough(db), T(11));
});

test("the cursor stops at the last complete line, in the same transaction as its rows, and resumes", () => {
  const root = fixture();
  const db = openStore(":memory:");
  indexTail(db, root);
  const bPath = join(root, "--Users-yong-proj", "b.jsonl");
  const f = db.prepare("SELECT byte_offset, line_count FROM files WHERE path = ?").get(bPath);
  assert.equal(f.byte_offset, Buffer.byteLength(B) - Buffer.byteLength(B.slice(B.lastIndexOf("\n") + 1)), "offset = end of the last newline");
  assert.equal(f.line_count, 5);

  assert.equal(indexTail(db, root).entries, 0, "a second run over unchanged files indexes nothing");

  appendFileSync(bPath, "\n");                                  // pi flushes the newline
  const r = indexTail(db, root);
  assert.equal(r.entries, 1);
  assert.match(db.prepare("SELECT text FROM docs WHERE key LIKE 'e12@%'").get().text, /PARTIAL-LINE/);
  assert.equal(db.prepare("SELECT byte_offset FROM files WHERE path = ?").get(bPath).byte_offset, statSync(bPath).size);
});

test("--rebuild drops derived tables and re-indexes from byte 0", () => {
  const root = fixture();
  const db = openStore(":memory:");
  indexTail(db, root);
  const r = indexTail(db, root, { rebuild: true });
  assert.equal(r.entries, 5);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM docs").get().n, 5);
});
