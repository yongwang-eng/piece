import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { recoverWorker } from "./recover.ts";

const entry = (message, timestamp = "2026-09-11T00:00:10Z") => JSON.stringify({ type: "message", timestamp, message });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, isError = false) => entry({ role: "toolResult", toolCallId: id, isError });

test("recover defaults to latest session and all keeps chronological session boundaries", () => {
  const root = mkdtempSync(`${tmpdir()}/recover-`);
  try {
    const dir = `${root}/run/children/historian/sessions`;
    mkdirSync(dir, { recursive: true });
    const early = [entry({ role: "assistant", content: [{ type: "text", text: "early" }, call("p", "write", { path: "early-pending.txt" })] })].join("\n");
    const late = [
      JSON.stringify({ type: "session", timestamp: "2026-09-11T00:00:00Z" }),
      entry({ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "latest\nanswer" }, call("w", "write", { path: "/vault/report.md" }), call("e", "edit", { path: "failed.ts" }), call("pending", "write", { path: "pending.txt" }), call("r", "read", { path: "read.txt" })] }),
      result("w"), result("e", true), result("r"), result("p"),
      entry({ role: "assistant", content: [call("read", "read", { path: "other.txt" })] }),
      "{broken", '{"type":',
    ].join("\n");
    writeFileSync(`${dir}/02.jsonl`, late);
    writeFileSync(`${dir}/01.jsonl`, early);
    writeFileSync(`${dir}/ignored.log`, result("ignored"));
    const latest = recoverWorker(root, "historian");
    assert.equal(latest.length, 1);
    assert.equal(latest[0].sessionFile, "02.jsonl");
    assert.equal(latest[0].lastAssistantText, "latest\nanswer");
    assert.deepEqual(latest[0].paths, [{ path: "/vault/report.md", success: true }, { path: "failed.ts", success: false }, { path: "pending.txt", success: false }]);
    assert.equal(latest[0].tools, 5, "count calls including killed-mid-tool, not results");
    assert.equal(latest[0].malformed, 2);
    assert.equal(latest[0].span, "2026-09-11T00:00:00Z → 2026-09-11T00:00:10Z");
    const all = recoverWorker(root, "historian", true);
    assert.deepEqual(all.map((s) => s.sessionFile), ["01.jsonl", "02.jsonl"]);
    assert.equal(all[0].tools, 1);
    assert.deepEqual(all[0].paths, [{ path: "early-pending.txt", success: false }]);
    assert.equal(all[1].paths.some((p) => p.path === "early-pending.txt"), false);
    assert.equal(readFileSync(`${dir}/01.jsonl`, "utf8"), early);
    assert.equal(readFileSync(`${dir}/02.jsonl`, "utf8"), late);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recover includes simple bash output paths, commands and attempted errors and caps only assistant text", () => {
  const root = mkdtempSync(`${tmpdir()}/recover-`);
  try {
    const dir = `${root}/run/children/worker/sessions`;
    mkdirSync(dir, { recursive: true });
    const commands = ["echo hi > a.txt", "echo hi >> b.txt", "printf hi | tee c.txt", "cat > 'space file.txt'", "echo 'not > a-path'", "echo hi | tee -a d.txt"];
    const lines = [entry({ role: "assistant", content: [{ type: "text", text: "z".repeat(2100) }, ...commands.map((command, i) => call(String(i), "bash", { command }))] }), ...commands.map((_c, i) => result(String(i), i === 1))];
    writeFileSync(`${dir}/one.jsonl`, lines.join("\n"));
    const [r] = recoverWorker(root, "worker");
    assert.equal(r.lastAssistantText, "z".repeat(2000));
    assert.equal(r.tools, 6);
    assert.deepEqual(r.paths.map((p) => p.path), ["a.txt", "b.txt", "c.txt", "space file.txt", "d.txt"]);
    assert.equal(r.paths[1].success, false);
    assert.equal(r.paths[1].command, commands[1]);
    assert.ok(r.paths.filter((p) => p.path !== "b.txt").every((p) => p.success));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovery refuses ambiguous/invalid/missing names and handles an empty session folder", () => {
  const root = mkdtempSync(`${tmpdir()}/recover-`);
  try {
    mkdirSync(`${root}/a/children/worker/sessions`, { recursive: true });
    assert.deepEqual(recoverWorker(root, "worker"), []);
    assert.throws(() => recoverWorker(root, "missing"), /no saved sessions/i);
    assert.throws(() => recoverWorker(root, "../worker"), /invalid worker name/i);
    mkdirSync(`${root}/b/children/worker/sessions`, { recursive: true });
    assert.throws(() => recoverWorker(root, "worker"), /ambiguous.*a.*b/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
