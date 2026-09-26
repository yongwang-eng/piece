import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchOf, lastRounds, peek, renderBorrowed, renderRounds, estimateTokens } from "./reader.ts";

// A small session: header, 3 rounds on the main branch, one abandoned branch (a user message whose parent is round 1's
// assistant — pi's tree after an edit/retry), a compaction, a room message, and a thinking block to drop.
const T = (i) => new Date(Date.UTC(2026, 8, 17, 18, i)).toISOString();
const entries = [
  { type: "session", version: 3, id: "s", timestamp: T(0), cwd: "/x/proj" },
  { type: "message", id: "u1", parentId: null, timestamp: T(1), message: { role: "user", content: [{ type: "text", text: "what does the DLQ monitor watch?" }] } },
  { type: "message", id: "a1", parentId: "u1", timestamp: T(2), message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "rg -n dlq infra/monitors.tf" } }] } },
  { type: "message", id: "r1", parentId: "a1", timestamp: T(2), message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "x".repeat(4000) }] } },
  { type: "message", id: "a1b", parentId: "r1", timestamp: T(3), message: { role: "assistant", content: [{ type: "text", text: "It watches `events.dlq.depth` > 0 for 5m." }] } },
  // abandoned branch off a1b: never reaches the leaf
  { type: "message", id: "ux", parentId: "a1b", timestamp: T(3), message: { role: "user", content: [{ type: "text", text: "ABANDONED" }] } },
  { type: "custom_message", id: "cm", parentId: "a1b", timestamp: T(4), customType: "room_message", content: "[room · inform] noise" },
  { type: "message", id: "u2", parentId: "cm", timestamp: T(5), message: { role: "user", content: "and who owns the alert?" } },
  { type: "message", id: "a2", parentId: "u2", timestamp: T(6), message: { role: "assistant", content: [{ type: "text", text: "Platform, per the on-call doc." }] } },
  { type: "compaction", id: "c1", parentId: "a2", timestamp: T(7), summary: "## Goal\nDLQ alert split", firstKeptEntryId: "u2" },
  { type: "message", id: "u3", parentId: "c1", timestamp: T(8), message: { role: "user", content: [{ type: "text", text: "split it into transport vs consumer" }] } },
  { type: "message", id: "a3", parentId: "u3", timestamp: T(9), message: { role: "assistant", content: [{ type: "text", text: "Done: two monitors, PR #1091." }] } },
];
const dir = mkdtempSync(join(tmpdir(), "borrow-"));
const file = join(dir, "s.jsonl");
writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

test("branchOf follows parentId from the leaf: the abandoned branch and nothing after the leaf", () => {
  const ids = branchOf(file).map((e) => e.id);
  assert.deepEqual(ids, ["u1", "a1", "r1", "a1b", "cm", "u2", "a2", "c1", "u3", "a3"]);
});

test("lastRounds: a round is user → its assistant replies; newest last; thinking dropped; tool results elided to one line", () => {
  const rounds = lastRounds(file, 2);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].user, "and who owns the alert?");
  assert.equal(rounds[1].user, "split it into transport vs consumer");
  const all = lastRounds(file, 10);
  assert.equal(all.length, 3, "three real rounds; the room message and the abandoned user turn are not rounds");
  const r1 = all[0];
  assert.ok(!r1.steps.some((s) => /secret/.test(s.text)), "thinking never crosses sessions");
  assert.ok(r1.steps.some((s) => s.kind === "tool" && /\[bash · 4\.0k chars · rg -n dlq infra\/monitors\.tf\]/.test(s.text)), JSON.stringify(r1.steps));
  assert.ok(r1.steps.some((s) => s.kind === "assistant" && /events\.dlq\.depth/.test(s.text)));
  assert.equal(r1.at, T(1));
});

test("peek reads the tail cheaply: last user message + last activity", () => {
  const p = peek(file);
  assert.equal(p.lastUser, "split it into transport vs consumer");
  assert.equal(p.lastAt, T(9));
});

test("renderBorrowed: one message, the frame first, provenance, rounds fenced, tokens estimated", () => {
  const rounds = lastRounds(file, 2);
  const text = renderBorrowed(rounds, { from: "11 harness · proj_events_rearch", cwd: "/x/proj" });
  assert.match(text, /^\[BORROWED CONTEXT — from another live pi session, not this session's history\]/);
  assert.match(text, /11 harness · proj_events_rearch/);
  assert.match(text, /2 rounds/);
  assert.match(text, /nothing below happened here/i);
  assert.ok(text.indexOf("── round 1 ") < text.indexOf("── round 2 "));
  assert.match(text, /Yong: and who owns the alert\?/);
  assert.match(text, /assistant: Platform, per the on-call doc\./);
  assert.ok(estimateTokens(text) > 50 && estimateTokens(text) < 400, String(estimateTokens(text)));
});

test("lastRounds caps by tokens: oldest rounds fall off first, never a partial round", () => {
  const one = lastRounds(file, 1);
  const budget = estimateTokens(renderRounds(one)); // room for exactly the newest round
  const all = lastRounds(file, 10, { maxTokens: budget });
  assert.equal(all.length, 1);
  assert.equal(all[0].user, "split it into transport vs consumer");
});
