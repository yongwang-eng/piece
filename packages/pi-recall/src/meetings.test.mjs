import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.ts";
import { CHUNK } from "./extract.ts";
import { loadRules, tag, speaker, turns, blocks, meetingDocs, indexMeetings, WORKHUB_PREFIX } from "./meetings.ts";

const rules = loadRules();
const two = [{ name: "Jane Doe", email: "y@x" }, { name: "Sam Lee", email: "p@x" }];
const many = [{ name: "Jane Doe" }, { name: "A B" }, { name: "C D" }, { name: "E F" }, { name: "G H" }, { name: "I J" }];

test("tag: series rows win, fallback is by participant count, every 153-title class has a home", () => {
  assert.deepEqual(tag({ title: "🌟 All Hands 🙌", participants: many }, rules), { kind: "all_hands", series: "All Hands", sub: null, recurring: true });
  assert.deepEqual(tag({ title: "ENT IAM - Team Retro", participants: many }, rules), { kind: "team", series: "ENT IAM Team Jam", sub: null, recurring: true });
  assert.deepEqual(tag({ title: "Enterprise (SAML, SCIM, RBAC/FGA, SIEM, Admin Portal)", participants: many }, rules).series, "Enterprise IAM");
  assert.deepEqual(tag({ title: "60 day check in: Jane Doe / Sam", participants: two }, rules), { kind: "one_on_one", series: "Sam", sub: "check_in", recurring: true });
  assert.equal(tag({ title: "Vignesh / Jane failover test", participants: two }, rules).kind, "dedicated", "a suffixed 1:1 title is a dedicated pair, not the recurring series");
  assert.deepEqual(tag({ title: "Katie / Jane intro", participants: two }, rules), { kind: "one_on_one", series: null, sub: "intro", recurring: false });
  assert.equal(tag({ title: "Security incident notes", participants: [{ name: "Jane Doe" }] }, rules).kind, "solo");
  assert.equal(tag({ title: "Audit Logs Prioritization", participants: many }, rules).kind, "dedicated");
});

test("speaker: mic → recorder, named system audio → the name, unnamed → other participant only in a 1:1", () => {
  const t1 = tag({ title: "Jane <> Sam", participants: two }, rules);
  assert.equal(speaker("Microphone", { participants: two }, t1, rules), "Jane");
  assert.equal(speaker("System audio", { participants: two }, t1, rules), "Sam Lee");
  assert.equal(speaker("System audio (Alex)", { participants: two }, t1, rules), "Alex");
  const tg = tag({ title: "ENT IAM Sync", participants: many }, rules);
  assert.equal(speaker("System audio", { participants: many }, tg, rules), "System audio", "a group's unnamed voice stays unnamed");
});

test("turns + blocks: split on blank lines, never split a turn, block ≈ CHUNK", () => {
  const long = "System audio: " + "word ".repeat(400).trim();            // ~2 000 chars, longer than a block
  const raw = ["Microphone: hi", "System audio: hello there", long, "Microphone: ok\nsecond line same turn", "System audio: bye"].join("\n\n");
  const t1 = tag({ title: "Jane <> Sam", participants: two }, rules);
  const ts = turns(raw, { participants: two }, t1, rules);
  assert.equal(ts.length, 5);
  assert.equal(ts[3], "Yong: ok\nsecond line same turn", "a multi-line turn stays one turn");
  const bs = blocks(ts);
  assert.ok(bs.length >= 3, `long turn forces its own block: ${bs.length}`);
  assert.deepEqual(bs.find(b => b.length === 1 && b[0].length > CHUNK), [ts[2]], "the long turn stands alone");
  for (const b of bs) if (b.length > 1) assert.ok(b.join("\n\n").length <= CHUNK - 200);
  assert.deepEqual(bs.flat(), ts, "no turn lost or duplicated");
});

test("meetingDocs: summary entry first, every block carries the tag header, keys follow id@ts", () => {
  const m = { granola_uuid: "u1", title: "Jane <> Sam", date_iso: "2026-08-17T21:00:00.000Z", date_raw: null, participants: two, summary: "# Topics\n- a", raw_text: "Microphone: hi\n\nSystem audio: hello", captured_at: "2026-09-18T00:00:00.000Z" };
  const { docs } = meetingDocs(m, rules);
  assert.equal(docs[0].kind, "meeting_summary"); assert.equal(docs[0].key, "u1#summary@2026-08-17T21:00:00.000Z");
  assert.equal(docs[1].key, "u1#b001@2026-08-17T21:00:00.000Z"); assert.equal(docs[1].parent_id, "u1#summary");
  assert.match(docs[1].text, /^\[one_on_one · Sam · recurring · 2026-08-17\] Jane <> Sam · with Sam Lee · part 1\/1\n/);
  assert.match(docs[1].text, /\nJane: hi\n\nSam Lee: hello$/);
  const big = meetingDocs({ ...m, title: "ENT IAM Sync", participants: many }, rules).docs[1].text;
  assert.match(big, /^\[team · ENT IAM Sync · recurring · 2026-08-17\] ENT IAM Sync · 6 participants · part 1\/1\n/, "above header_names_max the header counts, not names");
  const four = meetingDocs({ ...m, title: "Audit Logs Prioritization", participants: many.slice(0, 5) }, rules).docs[1].text;
  assert.match(four, /^\[dedicated · 2026-08-17\] Audit Logs Prioritization · with A B, C D, E F, G H · part 1\/1\n/, "at the max, names are listed");
});

function fixtureHub(dir, rows) {
  const p = join(dir, "hub.db"); const db = new DatabaseSync(p);
  db.exec("CREATE TABLE IF NOT EXISTS transcripts (granola_uuid TEXT PRIMARY KEY, title TEXT, date_iso TEXT, date_raw TEXT, participants TEXT, summary TEXT, raw_text TEXT, captured_at TEXT)");
  const ins = db.prepare("INSERT OR REPLACE INTO transcripts VALUES (?,?,?,?,?,?,?,?)");
  for (const r of rows) ins.run(r.granola_uuid, r.title, r.date_iso, null, JSON.stringify(r.participants), r.summary, r.raw_text, r.captured_at);
  db.close(); return p;
}
const count = (db, sql) => db.prepare(sql).get().n;

test("indexMeetings: incremental on captured_at, replaced whole, no orphan chunks or vecs", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-meet-"));
  const row = { granola_uuid: "u1", title: "Jane <> Sam", date_iso: "2026-08-17T21:00:00.000Z", participants: two, summary: "s", raw_text: "Microphone: hi\n\nSystem audio: " + "x ".repeat(900), captured_at: "2026-09-18T00:00:00.000Z" };
  const hub = fixtureHub(dir, [row]);
  const db = openStore(":memory:");
  const r1 = indexMeetings(db, hub, rules);
  assert.equal(r1.meetings, 1); assert.ok(r1.entries >= 3, `summary + ≥2 blocks: ${r1.entries}`); assert.equal(r1.unchanged, 0);
  assert.equal(count(db, "SELECT COUNT(*) n FROM docs WHERE role = 'meeting'"), r1.entries);
  assert.equal(db.prepare("SELECT cwd FROM docs WHERE session = 'u1' LIMIT 1").get().cwd, "meetings/Sam");
  // fake a vector so the delete path is exercised
  const cid = db.prepare("SELECT id FROM chunks WHERE key LIKE 'u1#%' LIMIT 1").get().id;
  db.prepare("INSERT INTO vecs(chunk_id, model_id, emb) VALUES (?, 'm', x'00')").run(cid);
  const r2 = indexMeetings(db, hub, rules);
  assert.deepEqual([r2.meetings, r2.unchanged], [0, 1], "same captured_at → skipped");
  assert.equal(count(db, "SELECT COUNT(*) n FROM vecs"), 1);
  fixtureHub(dir, [{ ...row, raw_text: "Microphone: rewritten", captured_at: "2026-09-19T00:00:00.000Z" }]);
  const r3 = indexMeetings(db, hub, rules);
  assert.equal(r3.meetings, 1);
  assert.equal(count(db, "SELECT COUNT(*) n FROM docs WHERE session = 'u1'"), 2, "summary + one block after the rewrite");
  assert.equal(count(db, "SELECT COUNT(*) n FROM chunks WHERE key NOT IN (SELECT key FROM docs)"), 0, "no orphan chunks");
  assert.equal(count(db, "SELECT COUNT(*) n FROM vecs"), 0, "stale vector removed with its chunk");
  assert.equal(db.prepare("SELECT path FROM files WHERE path LIKE ?").get(WORKHUB_PREFIX + "%").path, "workhub:u1");
  assert.equal(count(db, "SELECT COUNT(*) n FROM chunks_fts WHERE chunks_fts MATCH 'rewritten'"), 1, "lexical lane sees the new text");
});

test("indexMeetings: no archive on this machine → nothing indexed, no throw", () => {
  const db = openStore(":memory:");
  assert.deepEqual(indexMeetings(db, join(tmpdir(), "does-not-exist-" + Date.now(), "x.db"), rules), { meetings: 0, entries: 0, chunks: 0, unchanged: 0 });
});
