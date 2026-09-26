import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { postNote, postAlert, retire, producerToken } from "./note.ts";

test("postNote: bearer from the source's row, a note card with the id sanitised; no token → problem, no fetch", async () => {
  const dir = mkdtempSync("/tmp/halo-"); writeFileSync(`${dir}/s.json`, JSON.stringify({ sources: [{ name: "pi-crew", token: "tok" }] }));
  assert.equal(producerToken("pi-crew", `${dir}/s.json`), "tok");
  assert.equal(producerToken("nobody", `${dir}/s.json`), null);
  const sent = [], problems = [];
  postNote({ id: "secret:staging key:bash", source: "pi-crew", title: "t", body: "b" }, (k, m) => problems.push(k), async (url, init) => { sent.push({ url, init }); return { ok: true }; });
  assert.equal(sent.length, 1);
  const card = JSON.parse(sent[0].init.body);
  assert.equal(card.id, "secret:staging_key:bash");
  assert.equal(card.urgency, "note");
  assert.equal(sent[0].init.headers.authorization, "Bearer tok");
  postNote({ id: "x", source: "nobody", title: "t", body: "b" }, (k) => problems.push(k), async () => { throw new Error("must not fetch"); });
  assert.deepEqual(problems, ["halo:token"]);
});

test("postAlert: an `act` with no actions and a TTL; retire sends DELETE with the reason under the same bearer", async () => {
  const dir = mkdtempSync("/tmp/halo-"); writeFileSync(`${dir}/s.json`, JSON.stringify({ sources: [{ name: "pi-crew", token: "tok" }] }));
  producerToken("pi-crew", `${dir}/s.json`);
  const sent = [];
  const fetchMock = async (url, init) => { sent.push({ url, init }); return { ok: true }; };
  postAlert({ id: "secret:devin:unlock", source: "pi-crew", title: "🔑 unlocking devin", body: "b", ttlMs: 120_000 }, () => {}, fetchMock);
  const card = JSON.parse(sent[0].init.body);
  assert.equal(card.urgency, "act");
  assert.equal(card.actions, undefined);
  assert.ok(Date.parse(card.expires_at) - Date.now() > 100_000 && Date.parse(card.expires_at) - Date.now() <= 120_000);
  retire({ id: "secret:devin:unlock", source: "pi-crew", reason: "unlock finished" }, () => {}, fetchMock);
  assert.equal(sent[1].init.method, "DELETE");
  assert.ok(sent[1].url.endsWith("/v1/cards/secret%3Adevin%3Aunlock"));
  assert.equal(JSON.parse(sent[1].init.body).reason, "unlock finished");
  assert.equal(sent[1].init.headers.authorization, "Bearer tok");
});
