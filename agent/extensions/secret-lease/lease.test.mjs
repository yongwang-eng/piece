import assert from "node:assert/strict";
import test from "node:test";
import { Lease } from "./lease.ts";

const registry = {
  devin: { item: "devin-api", vault: "Employee", ttl_hours: 12, fields: { credential: "DEVIN_API_KEY", org_id: "DEVIN_ORG_ID" } },
};
const items = { "Employee/devin-api": { credential: "cog_secret", org_id: "org_1" } };
const reader = async (vault, item) => items[`${vault}/${item}`];

test("unlock puts every mapped field into env and reports names only", async () => {
  const env = {};
  const l = new Lease(registry, reader, env);
  const msg = await l.unlock("devin");
  assert.equal(env.DEVIN_API_KEY, "cog_secret");
  assert.equal(env.DEVIN_ORG_ID, "org_1");
  assert.match(msg, /devin.*DEVIN_API_KEY.*DEVIN_ORG_ID/s);
  assert.doesNotMatch(msg, /cog_secret|org_1/, "values never appear in tool output");
});

test("unlisted name is refused without touching the reader", async () => {
  let reads = 0;
  const l = new Lease(registry, async () => { reads++; return {}; }, {});
  await assert.rejects(l.unlock("prod_db"), /not in config\/secrets\.json/);
  assert.equal(reads, 0);
});

test("second unlock is a cache hit — one approval per pi process", async () => {
  let reads = 0;
  const l = new Lease(registry, async (...a) => { reads++; return reader(...a); }, {});
  await l.unlock("devin"); await l.unlock("devin");
  assert.equal(reads, 1);
});

test("a field missing on the item fails closed and sets nothing", async () => {
  const env = {};
  const l = new Lease(registry, async () => ({ credential: "x" }), env);
  await assert.rejects(l.unlock("devin"), /org_id/);
  assert.equal(env.DEVIN_API_KEY, undefined);
});

test("lock removes the vars and the cache; status lists names, never values", async () => {
  const env = { HOME: "/u" };
  const l = new Lease(registry, reader, env);
  await l.unlock("devin");
  assert.deepEqual(l.status(), ["devin → DEVIN_API_KEY, DEVIN_ORG_ID"]);
  l.lock("devin");
  assert.deepEqual(env, { HOME: "/u" });
  assert.deepEqual(l.status(), []);
});

test("a fixed TTL from unlock expires the lease: vars removed, next unlock re-reads", async () => {
  let now = 1_000_000, reads = 0;
  const env = {};
  const l = new Lease(registry, async (...a) => { reads++; return reader(...a); }, env, () => now);
  await l.unlock("devin");
  now += 11 * 3600_000; await l.unlock("devin");            // still inside 12h: cache hit, no re-prompt
  assert.equal(reads, 1); assert.equal(env.DEVIN_API_KEY, "cog_secret");
  now += 2 * 3600_000;                                       // 13h after unlock, use is NOT sliding
  assert.deepEqual(l.status(), []);                          // status sweeps expired leases
  assert.equal(env.DEVIN_API_KEY, undefined, "expired vars are removed from env");
  await l.unlock("devin"); assert.equal(reads, 2);
});

test("a warm unlock is reported as a hit — the moment a cached secret is reused", async () => {
  const hits = [];
  const l = new Lease(registry, reader, {}, Date.now, (name) => hits.push(name));
  await l.unlock("devin");
  assert.deepEqual(hits, []);
  await l.unlock("devin");
  assert.deepEqual(hits, ["devin"]);
});

test("leasedVars maps each live env var back to its secret; expired ones drop out", async () => {
  let t = 0;
  const l = new Lease(registry, reader, {}, () => t);
  assert.deepEqual([...l.leasedVars()], []);
  await l.unlock("devin");
  assert.deepEqual([...l.leasedVars()].sort(), [["DEVIN_API_KEY", "devin"], ["DEVIN_ORG_ID", "devin"]]);
  t = 13 * 3600_000;
  assert.deepEqual([...l.leasedVars()], []);
});

test("valueFor resolves an op:// ref to the leased value and names the secret; unknown or cold refs → undefined", async () => {
  const env = {};
  const l = new Lease(registry, reader, env);
  assert.equal(l.valueFor("op://Employee/devin-api/credential"), undefined);   // not leased yet
  await l.unlock("devin");
  assert.deepEqual(l.valueFor("op://Employee/devin-api/credential"), { name: "devin", value: "cog_secret" });
  assert.deepEqual(l.valueFor("op://Employee/devin-api/org_id"), { name: "devin", value: "org_1" });
  assert.equal(l.valueFor("op://Employee/devin-api/nope"), undefined);
  assert.equal(l.valueFor("op://Other/devin-api/credential"), undefined);
  l.lock("devin");
  assert.equal(l.valueFor("op://Employee/devin-api/credential"), undefined);   // locked → gone, even though the row exists
  // a var that is merely PRESENT in env (exported by a shell, never leased) is not ours to hand over
  const stray = new Lease(registry, reader, { DEVIN_API_KEY: "from_shell" });
  assert.equal(stray.valueFor("op://Employee/devin-api/credential"), undefined);
});

test("a reload keeps the lease: a second Lease over the same env + ledger is warm, no read, still hands over; without the ledger it is cold", async () => {
  const env = {}; const ledger = new Map(); let reads = 0;
  const rd = async (...a) => { reads++; return reader(...a); };
  const a = new Lease(registry, rd, env, Date.now, () => {}, ledger);
  await a.unlock("devin");
  const b = new Lease(registry, rd, env, Date.now, () => {}, ledger);          // the extension re-instantiated by /reload
  await b.unlock("devin");
  assert.equal(reads, 1, "warm across the reload");
  assert.equal(b.valueFor("op://Employee/devin-api/credential")?.name, "devin");
  const c = new Lease(registry, rd, env);                                       // ledger lost → env var alone is not a lease
  assert.equal(c.valueFor("op://Employee/devin-api/credential"), undefined);
});

test("isWarm: false before the first read and after lock/expiry, true while leased", async () => {
  let t = 0; const l = new Lease(registry, reader, {}, () => t);
  assert.equal(l.isWarm("devin"), false);
  await l.unlock("devin");
  assert.equal(l.isWarm("devin"), true);
  t += 13 * 3600_000;
  assert.equal(l.isWarm("devin"), false, "expired");
});
