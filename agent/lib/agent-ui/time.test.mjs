import test from "node:test";
import assert from "node:assert/strict";
import { elapsed } from "./time.ts";

test("elapsed: 45s · 3m07 · 2h05 · 1d · 4d — days once a row has lived a day (D97 paused rows)", () => {
  assert.equal(elapsed(45_000), "45s");
  assert.equal(elapsed(187_000), "3m07");
  assert.equal(elapsed(2 * 3_600_000 + 5 * 60_000), "2h05");
  assert.equal(elapsed(23 * 3_600_000 + 59 * 60_000), "23h59");
  assert.equal(elapsed(24 * 3_600_000), "1d");
  assert.equal(elapsed(4 * 86_400_000 + 3 * 3_600_000), "4d");
  assert.equal(elapsed(-5), "0s");
});
