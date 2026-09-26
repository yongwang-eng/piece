import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claim, release, verdict } from "./lease.ts";

const dir = () => mkdtempSync(join(tmpdir(), "lease-"));
const alive = new Set([100, 200]);
const isAlive = (pid) => alive.has(pid);

test("verdict: no lease → free; my own pid → mine; a dead pid → stale; a live foreign pid → occupied", () => {
  assert.equal(verdict(undefined, 100, isAlive), "free");
  assert.equal(verdict({ pid: 100 }, 100, isAlive), "mine");
  assert.equal(verdict({ pid: 999 }, 100, isAlive), "stale");
  assert.equal(verdict({ pid: 200 }, 100, isAlive), "occupied");
});

test("claim writes the lease for a free/stale/mine session and reports the holder for an occupied one; nothing is overwritten then", () => {
  const d = dir();
  const a = claim({ dir: d, sessionId: "s1", file: "/s/s1.jsonl", pid: 100, cwd: "/w", isAlive });
  assert.equal(a.verdict, "free");
  assert.deepEqual(JSON.parse(readFileSync(join(d, "s1.json"), "utf8")).pid, 100);
  const b = claim({ dir: d, sessionId: "s1", file: "/s/s1.jsonl", pid: 200, cwd: "/w", isAlive });
  assert.equal(b.verdict, "occupied"); assert.equal(b.holder.pid, 100);
  assert.equal(JSON.parse(readFileSync(join(d, "s1.json"), "utf8")).pid, 100, "the occupant keeps the lease");
  alive.delete(100);
  const c = claim({ dir: d, sessionId: "s1", file: "/s/s1.jsonl", pid: 200, cwd: "/w", isAlive });
  assert.equal(c.verdict, "stale"); assert.equal(JSON.parse(readFileSync(join(d, "s1.json"), "utf8")).pid, 200, "a dead holder is healed, not reported");
  alive.add(100);
});

test("release removes only MY lease — never the occupant's", () => {
  const d = dir();
  claim({ dir: d, sessionId: "s2", file: "/s/s2.jsonl", pid: 100, cwd: "/w", isAlive });
  release({ dir: d, sessionId: "s2", pid: 200 });
  assert.ok(existsSync(join(d, "s2.json")), "pid 200 does not own it");
  release({ dir: d, sessionId: "s2", pid: 100 });
  assert.ok(!existsSync(join(d, "s2.json")));
});

test("a malformed lease file counts as stale (fail toward continuing, the damage class is a mistake)", () => {
  const d = dir();
  writeFileSync(join(d, "s3.json"), "{ nope");
  assert.equal(claim({ dir: d, sessionId: "s3", file: "/s/s3.jsonl", pid: 100, cwd: "/w", isAlive }).verdict, "stale");
});
