import assert from "node:assert/strict";
import test from "node:test";

import { blockReasonFor } from "./index.ts";

const blocked = (cmd) => {
  const r = blockReasonFor(cmd);
  assert.ok(r, `expected BLOCKED: ${cmd}`);
  return r;
};
const allowed = (cmd) => assert.equal(blockReasonFor(cmd), undefined, `expected ALLOWED: ${cmd}`);

// ── public exposure (Acme security directive, escalated 2026-09-08) ────────
test("tunnel tools are blocked by name", () => {
  for (const cmd of [
    "ngrok http 9700",
    "npx localtunnel --port 3000",
    "cloudflared tunnel --url http://localhost:9700",
    "ssh -R 80:localhost:9700 serveo.net",
    "tailscale funnel 9700",
    "bore local 9700 --to bore.pub",
    "zrok share public localhost:9700",
  ]) {
    assert.match(blocked(cmd), /public exposure|tunnel/i);
  }
});

test("binding a service to a public interface is blocked — the shims cannot catch this", () => {
  for (const cmd of [
    "python3 -m http.server 8000 --bind 0.0.0.0",
    "node server.js --host 0.0.0.0",
    "caddy file-server --listen 0.0.0.0:9700",
    "uvicorn app:app --host 0.0.0.0 --port 8000",
  ]) {
    assert.match(blocked(cmd), /public interface|0\.0\.0\.0/i);
  }
});

test("cloudflared access stays allowed — it is the Okta login, not a tunnel", () => {
  allowed("cloudflared access login https://sink.example.com");
  allowed("cloudflared access token -app=https://sink.example.com");
});

test("loopback binds and mentions of 0.0.0.0 in text are not blocked", () => {
  allowed("python3 -m http.server 8000 --bind 127.0.0.1");
  allowed("node server.js --host localhost");
  allowed("rg '0.0.0.0' packages/api/src");
  allowed("cat terraform/main.tf | grep 0.0.0.0");
});

// ── existing destructive-command patterns still hold ────────────────────────
test("destructive git/sql patterns still blocked", () => {
  blocked("git reset --hard HEAD~3");
  blocked("git clean -fd");
  blocked("git push --force origin main");
  blocked("DROP TABLE directory_users");
});

test("safe neighbours still allowed", () => {
  allowed("git reset HEAD file.ts");
  allowed("git status");
  allowed("git push origin my-branch");
  allowed("SELECT * FROM directory_users LIMIT 10");
});

// ── credential-file reads (an earlier incident: auth.json landed in a session transcript) ──
import { blockReasonForRead } from "./index.ts";

const readBlocked = (p) => {
  const r = blockReasonForRead(p);
  assert.ok(r, `expected BLOCKED read: ${p}`);
  return r;
};
const readAllowed = (p) => assert.equal(blockReasonForRead(p), undefined, `expected ALLOWED read: ${p}`);

test("reading a credential store is blocked — it bakes a live token into the transcript", () => {
  for (const p of [
    "/Users/me/.pi/agent/auth.json",
    "/Users/me/.claude/.credentials.json",
    "/Users/me/.codex/auth.json",
    "/Users/me/.aws/credentials",
    "/Users/me/.ssh/id_rsa",
    "/Users/me/Code/acme/app/.env",
    "/Users/me/some/service-account.pem",
  ]) {
    assert.match(readBlocked(p), /credential|secret|transcript/i);
  }
});

test("bash that cats a credential store is blocked too", () => {
  assert.ok(blockReasonFor("cat ~/.pi/agent/auth.json"));
  assert.ok(blockReasonFor("jq . /Users/me/.codex/auth.json"));
  assert.ok(blockReasonFor("cat .env | grep KEY"));
});

test("held-fixed controls: examples, configs and ordinary files still readable", () => {
  readAllowed("/Users/me/Code/acme/app/.env.example");
  readAllowed("/Users/me/.pi/agent/settings.json");
  readAllowed("/Users/me/.agents/mcp.json");
  readAllowed("/Users/me/Code/acme/app/packages/api/src/scim/scim-v2-0.controller.ts");
  assert.equal(blockReasonFor("cat .env.example"), undefined);
  assert.equal(blockReasonFor("op read op://Employee/acme-staging-key/credential"), undefined);
});

// ── a secret main placed for a worker (approve-is-the-trigger) ───────────────
test("a placed worker secret is usable only inline as $(cat …); reading or echoing it is blocked", () => {
  const f = "/Users/me/.pi/agent/workers/runs/x/crew_10/children/verifier/secrets/1";
  allowed(`curl -s -H "Authorization: Bearer $(cat ${f})" https://api.acme-test.example/organizations`);
  blocked(`cat ${f}`);
  blocked(`echo $(cat ${f})`);
  blocked(`$(cat ${f})`);
  blocked(`cp ${f} /tmp/x`);
});

// ── every shell-running tool is guarded (bg_run added 2026-09-17) ─────────────
import { COMMAND_TOOLS } from "./index.ts";
test("bg_run's command goes through the same gate as bash", () => {
  assert.ok(COMMAND_TOOLS.has("bash"));
  assert.ok(COMMAND_TOOLS.has("bg_run"), "bg_run runs `bash -lc <command>` — an unlisted shell tool is a guard bypass");
});
