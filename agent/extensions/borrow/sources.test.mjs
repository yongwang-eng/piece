import { test } from "node:test";
import assert from "node:assert";
import { parseArgs } from "./sources.ts";

test("parseArgs: window pick, count, minutes, about, and the question after --", () => {
  assert.deepEqual(parseArgs(""), { pick: undefined, n: 10, since: undefined, about: undefined, question: undefined });
  assert.equal(parseArgs("events 8").n, 8);
  assert.equal(parseArgs("events 8").pick, "events");
  const m = parseArgs("pi-events 30m"); assert.equal(m.pick, "pi-events"); assert.equal(m.n, 999); assert.ok(m.since && Date.now() - Date.parse(m.since) < 31 * 60_000);
  const ab = parseArgs('harness about "DLQ monitor" 3'); assert.equal(ab.pick, "harness"); assert.equal(ab.n, 3); assert.ok(ab.about.test("the dlq MONITOR fired"));
  const q = parseArgs("observe -- how did they split the alert?"); assert.equal(q.pick, "observe"); assert.equal(q.question, "how did they split the alert?");
});
