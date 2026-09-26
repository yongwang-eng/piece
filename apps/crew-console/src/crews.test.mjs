import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { timeline } from "./crews.ts";

const line = (o) => JSON.stringify(o) + "\n";
const msg = (env) => line({ type: "message", envelope: { run: "crew_1", cites: undefined, ...env } });

test("the room timeline carries what members SAID, not only lifecycle: worker↔worker and main↔worker text, in time order; telemetry and consult wire bodies stay out", (t) => {
  const dir = mkdtempSync(`${tmpdir()}/crews-timeline-`); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(`${dir}/log.jsonl`,
    line({ at: "2026-09-15T02:00:00Z", event: "worker_spawned", worker: "reviewer" }) +
    line({ at: "2026-09-15T02:00:10Z", event: "task_sent", worker: "reviewer" }) +
    line({ at: "2026-09-15T02:00:30Z", event: "consult_to_human", worker: "reviewer", class: "irreversible", id: "c-reviewer-1-1" }));
  writeFileSync(`${dir}/room.jsonl`,
    msg({ id: "m1", at: "2026-09-15T02:00:10Z", from: "main", to: ["reviewer"], kind: "request", task: "task", text: "Review PR 12 for contract parity." }) +
    msg({ id: "m2", at: "2026-09-15T02:00:20Z", from: "reviewer", to: ["implementer"], kind: "inform", text: "your diff drops the null check at store.ts:40" }) +
    msg({ id: "m3", at: "2026-09-15T02:00:25Z", from: "reviewer", to: ["main"], kind: "request", task: "consult", re: "c-reviewer-1-1", text: '{"consult":{"id":"c-reviewer-1-1"}}' }) +
    msg({ id: "m4", at: "2026-09-15T02:00:26Z", from: "reviewer", to: ["main"], kind: "notice", task: "vitals", text: '{"contextPct":1}' }) +
    msg({ id: "m5", at: "2026-09-15T02:00:27Z", from: "room", to: ["*"], kind: "notice", text: "implementer joined as implementer — builds" }) +
    msg({ id: "m6", at: "2026-09-15T02:00:40Z", from: "human", to: ["reviewer"], kind: "result", re: "c-reviewer-1-1", text: "APPROVED by Yong" }) +
    msg({ id: "m7", at: "2026-09-15T02:00:50Z", from: "reviewer", to: ["main"], kind: "result", report: "done", text: "Verdict: approve, 4/5. " + "x".repeat(400) }));
  const rows = timeline(dir);
  assert.deepEqual(rows.map((r) => r.at), ["2026-09-15T02:00:00Z", "2026-09-15T02:00:10Z", "2026-09-15T02:00:20Z", "2026-09-15T02:00:30Z", "2026-09-15T02:00:50Z"], "merged and sorted; consult wire body, vitals, join notice and the consult answer (already a lifecycle row) are not repeated; task_sent is folded into the message that IS the task");
  assert.equal(rows[1].text, "main → reviewer: Review PR 12 for contract parity.");
  assert.equal(rows[2].text, "reviewer → implementer: your diff drops the null check at store.ts:40");
  assert.equal(rows[2].worker, "reviewer");
  assert.ok(rows[4].text.startsWith("reviewer → main: Verdict: approve, 4/5.") && rows[4].text.length <= 260, "long bodies are cut for the row; the full text stays in room.jsonl");
  assert.ok(rows.every((r) => r.icon), "every row has a glyph");
});

test("halo producer: a consult becomes a card whose action ids equal the console's option keys, with detail + callback on the console origin", async () => {
  const { cardOf, parseCardId, cardId } = await import("./halo.ts");
  const c = { run: "crew_11", id: "c-probe-184-1", worker: "probe", kind: "irreversible", state: "open", askedAt: 1000, question: "may I delete /tmp/x?", evidence: ["https://github.com/acme/x/pull/1", "ran the suite"],
    action: { verb: "delete", target: "/tmp/x" }, intent: { why: "probe", exact: "rm /tmp/x", effect: "gone", reversible: "yes", ifDenied: "stop" }, packet: { assessment: { risk: "low", recommendation: "approve" } }, thread: [] };
  const card = cardOf(c, "http://127.0.0.1:9900/", { "◆": 1 });
  assert.equal(card.id, "crew:crew_11:c-probe-184-1");
  assert.deepEqual(parseCardId(cardId(c)), { run: "crew_11", id: "c-probe-184-1" });
  assert.equal(card.title, "probe · irreversible · delete /tmp/x");
  assert.equal(card.format, "markdown");
  assert.equal(card.body, "may I delete /tmp/x?\n\n> ✓ **low** — approve", "question = paragraph 1; assessment = a `> ` callout with the risk glyph (halo §3g)");
  assert.deepEqual(card.links, [{ label: "github.com/acme/x/pull/1", url: "https://github.com/acme/x/pull/1" }], "only http(s) evidence becomes a link");
  assert.ok(card.actions.length >= 2 && card.actions.every((a) => typeof a.id === "string" && a.label), "actions mirror options");
  assert.equal(card.callback_url, "http://127.0.0.1:9900/api/halo/callback");
  assert.equal(card.detail_url, "http://127.0.0.1:9900/crews/crew_11#consults");
});

test("ownerWindow: the crew's main is labelled by its tmux window from the session lease; a dead or missing lease is null", async () => {
  const { ownerWindow } = await import("./crews.ts");
  const dir = mkdtempSync(`${tmpdir()}/leases-`);
  writeFileSync(`${dir}/s-live.json`, JSON.stringify({ pid: 4242, cwd: "/Users/me/x/proj_events", pane: "%28" }));
  writeFileSync(`${dir}/s-dead.json`, JSON.stringify({ pid: 4343, cwd: "/tmp/gone", pane: "%9" }));
  const where = (spot) => `11 harness (pid ${spot.pid})`;
  const alive = (pid) => pid === 4242;
  assert.equal(ownerWindow(dir, "s-live", where, alive), "11 harness (pid 4242)");
  assert.equal(ownerWindow(dir, "s-dead", where, alive), null, "a stale lease must not label a pane someone else now owns");
  assert.equal(ownerWindow(dir, "s-none", where, alive), null);
  assert.equal(ownerWindow(dir, null, where, alive), null);
  rmSync(dir, { recursive: true });
});
