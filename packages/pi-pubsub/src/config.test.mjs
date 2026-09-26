import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPubSubConfig, readEnvLine } from "./config.ts";

const files = (map) => (p) => { if (!(p in map)) throw new Error(`ENOENT ${p}`); return map[p]; };
const cfg = (extra = {}) => JSON.stringify({ host: "127.0.0.1", port: 16379, passwordEnv: "REDISCLI_AUTH", ...extra });

test("password comes from the env when set, else from the named line of passwordFile", () => {
  const readFile = files({ "/a/config/pubsub.json": cfg({ passwordFile: "/secret/pubsub.env" }), "/secret/pubsub.env": "# comment\nexport REDISCLI_AUTH=from-file\n" });
  assert.deepEqual(loadPubSubConfig({ agentDir: "/a", env: { REDISCLI_AUTH: "from-env" }, readFile }), { host: "127.0.0.1", port: 16379, password: "from-env" });
  assert.deepEqual(loadPubSubConfig({ agentDir: "/a", env: {}, readFile }), { host: "127.0.0.1", port: 16379, password: "from-file" });
});

test("a missing credential is a named error, never a silent unauthenticated client", () => {
  assert.throws(() => loadPubSubConfig({ agentDir: "/a", env: {}, readFile: files({ "/a/config/pubsub.json": cfg() }) }), /REDISCLI_AUTH is not set/);
  assert.throws(() => loadPubSubConfig({ agentDir: "/a", env: {}, readFile: files({ "/a/config/pubsub.json": cfg({ passwordFile: "/s.env" }), "/s.env": "OTHER=1\n" }) }), /has no REDISCLI_AUTH= line/);
  assert.throws(() => loadPubSubConfig({ agentDir: "/a", env: {}, readFile: files({}) }), /cannot read \/a\/config\/pubsub.json/);
});

test("only loopback hosts are accepted", () => {
  assert.throws(() => loadPubSubConfig({ agentDir: "/a", env: { X: "p" }, readFile: files({ "/a/config/pubsub.json": JSON.stringify({ host: "0.0.0.0", port: 16379, passwordEnv: "X" }) }) }), /must be loopback/);
  assert.throws(() => loadPubSubConfig({ agentDir: "/a", env: { X: "p" }, readFile: files({ "/a/config/pubsub.json": JSON.stringify({ host: "127.0.0.1", port: 70000, passwordEnv: "X" }) }) }), /port/);
});

test("readEnvLine handles export, quotes and picks the exact name", () => {
  const text = "export A=1\nAB='two'\nB = \"three\"\n";
  assert.equal(readEnvLine(text, "A"), "1"); assert.equal(readEnvLine(text, "AB"), "two"); assert.equal(readEnvLine(text, "B"), "three"); assert.equal(readEnvLine(text, "C"), undefined);
});
