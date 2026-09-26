import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newestSourceMtime, isStale } from "./staleness.ts";

const fixture = () => {
  const d = mkdtempSync(join(tmpdir(), "crew-stale-"));
  mkdirSync(join(d, "runtime"));
  writeFileSync(join(d, "index.ts"), "");
  writeFileSync(join(d, "runtime", "worker.ts"), "");
  writeFileSync(join(d, "README.md"), "");
  const t = Date.now() - 60_000;
  for (const f of ["index.ts", "runtime/worker.ts", "README.md"]) utimesSync(join(d, f), t / 1000, t / 1000);
  return { d, t };
};

test("nothing changed since load → not stale", () => {
  const { d, t } = fixture();
  assert.equal(isStale(newestSourceMtime(d), d), false);
  assert.ok(Math.abs(newestSourceMtime(d) - t) < 1500);
});

test("a nested .ts edited after load → stale (the bug: fix on disk, old code running)", () => {
  const { d } = fixture();
  const loaded = newestSourceMtime(d);
  const later = (Date.now() + 5_000) / 1000;
  utimesSync(join(d, "runtime", "worker.ts"), later, later);
  assert.equal(isStale(loaded, d), true);
});

test("a non-.ts file (README) edited after load → NOT stale — docs don't need a reload", () => {
  const { d } = fixture();
  const loaded = newestSourceMtime(d);
  const later = (Date.now() + 5_000) / 1000;
  utimesSync(join(d, "README.md"), later, later);
  assert.equal(isStale(loaded, d), false);
});

test("unreadable dir → 0, never throws", () => {
  assert.equal(newestSourceMtime("/nonexistent/crew"), 0);
});
