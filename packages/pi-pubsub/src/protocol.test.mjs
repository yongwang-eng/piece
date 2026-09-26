import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeMessage, encodeMessage, validateTopic, MAX_ENCODED_BYTES } from "./protocol.ts";

test("encode → decode round-trips a message; replyTo only when set", () => {
  const m = { id: "m1", senderId: "agent_50", sentAt: "2026-09-13T00:00:00.000Z", payload: { kind: "request", to: ["reviewer"] } };
  assert.deepEqual(decodeMessage(encodeMessage(m)), m);
  const r = { ...m, replyTo: "m0" };
  assert.deepEqual(decodeMessage(encodeMessage(r)), r);
  assert.equal(encodeMessage(m).includes("replyTo"), false);
});

test("decode rejects anything that is not a v1 message, without throwing", () => {
  const good = JSON.parse(encodeMessage({ id: "m1", senderId: "a", sentAt: "t", payload: null }));
  for (const bad of [
    "not json", "[]", "null", JSON.stringify({ ...good, v: 2 }), JSON.stringify({ ...good, id: "" }),
    JSON.stringify({ ...good, senderId: 7 }), JSON.stringify({ ...good, replyTo: 3 }),
    JSON.stringify((({ payload, ...rest }) => rest)(good)),
  ]) assert.equal(decodeMessage(bad), undefined, bad);
  assert.deepEqual(decodeMessage(JSON.stringify(good)), { id: "m1", senderId: "a", sentAt: "t", payload: null });
});

test("encode refuses missing identity and oversized payloads", () => {
  assert.throws(() => encodeMessage({ id: "", senderId: "a", sentAt: "t", payload: 1 }), /message\.id/);
  assert.throws(() => encodeMessage({ id: "x", senderId: "", sentAt: "t", payload: 1 }), /senderId/);
  assert.throws(() => encodeMessage({ id: "x", senderId: "a", sentAt: "t", payload: "y".repeat(MAX_ENCODED_BYTES) }), /cap is/);
});

test("topics are exact, lowercase, dotted names — no wildcards, no spaces, bounded", () => {
  for (const ok of ["crew.59c66327.crew_3", "a", "room:x-y.z", "0" + "a".repeat(127)]) assert.equal(validateTopic(ok), undefined, ok);
  for (const bad of ["", "Crew.x", "crew.*", "crew x", ".crew", "a".repeat(129), 42]) assert.match(validateTopic(bad) ?? "", /topic must match/, String(bad));
});
