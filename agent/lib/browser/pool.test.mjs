import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILES, ProfilePool, SCRATCH_POOL_SIZE, inferProfile, playwrightConfig } from "./pool.ts";
assert.ok(Array.isArray(PROFILES) && PROFILES.some((p) => p.pool), "the shipped registry loads and has a scratch pool");

// inference from URLs
// inferProfile is tested against its own fixture, not the shipped registry — the registry is per machine.
const FIX = [
  { name: "aws-staging", identities: ["aws-staging", "okta"], hosts: ["console.aws.amazon.com", "signin.aws.amazon.com"] },
  { name: "acme-staging", identities: ["acme-staging", "okta"], hosts: ["dashboard.acme-test.example"] },
  { name: "github", identities: ["github"], hosts: ["github.com"] },
  { name: "scratch", identities: [], hosts: [], pool: true },
];
const infer = (text, needs) => inferProfile(text, needs, FIX);
assert.equal(infer("open https://console.aws.amazon.com/sqs/v3/home?region=us-east-1").name, "aws-staging");
assert.equal(infer("check https://dashboard.acme-test.example/orgs").name, "acme-staging");
assert.equal(infer("read https://github.com/acme/app/pull/1").name, "github");
assert.equal(infer("open https://example.com and read the h1").name, "scratch", "public site → scratch, never carries a login");
assert.equal(infer("no urls at all").name, "scratch");
// explicit needs win over URLs
assert.equal(infer("open https://example.com", ["aws-staging"]).name, "aws-staging");
assert.throws(() => infer("x", ["okta"]), /Ambiguous/);
assert.throws(() => inferProfile("open https://github.com/x", ["nope"]), /Unknown/);

// leasing
const root = mkdtempSync(join(tmpdir(), "profiles-"));
const pool = new ProfilePool(root, FIX);
const aws = FIX.find((p) => p.name === "aws-staging");
const l1 = pool.lease(aws, "run-a", "browser");
assert.equal(l1.profile, "aws-staging"); assert.ok(existsSync(l1.lockPath));
// same holder re-leasing is idempotent
assert.equal(pool.lease(aws, "run-a", "browser").profile, "aws-staging");
// a different LIVE holder is refused with a useful message
assert.throws(() => pool.lease(aws, "run-b", "browser", 1), /in use by browser@run-a/);
// release frees it
pool.release(l1);
const l2 = pool.lease(aws, "run-b", "browser", 1);
assert.equal(l2.profile, "aws-staging");
// dead holder is treated as free
pool.release(l2, 1);
const stale = pool.lease(aws, "run-c", "browser", 999999);   // dead pid
assert.ok(stale); assert.equal(pool.lease(aws, "run-d", "browser").profile, "aws-staging", "stale lock from a dead pid is stolen");

// scratch pool hands out distinct copies, then exhausts
const scratch = FIX.find((p) => p.pool);
const got = new Set();
for (let i = 0; i < SCRATCH_POOL_SIZE; i++) got.add(pool.lease(scratch, `r${i}`, "browser", 1 /* alive */).profile);
assert.equal(got.size, SCRATCH_POOL_SIZE);
assert.throws(() => pool.lease(scratch, "r-extra", "browser", 1), /in use/);

// status lists singletons + pool + holders
const st = pool.status();
assert.ok(st.some((s) => s.name === "aws-staging" && s.holder?.run === "run-d"));
assert.ok(st.filter((s) => s.name.startsWith("scratch-")).length >= SCRATCH_POOL_SIZE);

// config points Playwright at the leased dir + evidence dir
const cfg = playwrightConfig("/p/aws-staging", "/e/run/browser/evidence");
assert.deepEqual(cfg.mcpServers.playwright.args.slice(-4), ["--user-data-dir", "/p/aws-staging", "--output-dir", "/e/run/browser/evidence"]);

console.log("browser-profiles: PASS");
