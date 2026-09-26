// Pure stable-id behaviour, backend-agnostic (crew's board wiring is tested under extensions/crew/ui).
import assert from "node:assert/strict";
import test from "node:test";

import { WorkerIds, resolveChild } from "./ids.ts";

test("allocation is monotonic per new worker object", () => {
  const ids = new WorkerIds();
  assert.equal(ids.assign({ name: "a" }).id, 1);
  assert.equal(ids.assign({ name: "b" }).id, 2);
  const c = ids.assign({ name: "c" });
  assert.equal(c.id, 3);
  assert.ok(ids.current(c));
  ids.reset();
  assert.ok(!ids.current(c), "a pre-reset worker is stale after reset");
  assert.equal(ids.assign({ name: "d" }).id, 1, "reset restarts numbering");
});

test("seed continues above ids that already exist (adopted workers outlive main)", () => {
  const ids = new WorkerIds();
  ids.seed(4);
  const a = ids.assign({ name: "new" });
  assert.equal(a.id, 5, "next id must clear the highest adopted id");
  ids.seed(2);
  assert.equal(ids.assign({ name: "other" }).id, 6, "seeding lower than the counter never rewinds it");
  ids.seed(Number.NaN);
  assert.equal(ids.assign({ name: "third" }).id, 7, "a garbage seed is ignored");
});

test("resolveChild works on any {id,name} — not just fleet agents", () => {
  const rows = [{ id: 1, name: "spies" }, { id: 2, name: "t1" }];
  assert.equal(resolveChild(rows, "#2"), "t1");
  assert.equal(resolveChild(rows, "spies"), "spies");
  assert.equal(resolveChild(rows, "#9"), undefined);
});
