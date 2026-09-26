// secret-lease — one Touch ID per secret per pi process (fixed TTL), value lives only in process.env.
// secret_unlock(name) → `op item get` (the tap is Yong's approval) → env vars every Bash/bg child inherits.
// secret_lock(name) forgets. /secrets shows names, never values. Registry: config/secrets.json.
// Every REUSE is told, never silent: a warm unlock, a bash command naming a leased var, or a handover to a crew worker
// (`secret:resolve` on pi.events, answered from this lease) posts one halo note each (reuse.ts finds the vars).
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { postNote, postAlert, retire } from "../../lib/halo/note.ts";
import { problems } from "../../lib/agent-ui/problems.ts";
import { where } from "../../lib/where.ts";
import { Lease, processLedger, type Registry } from "./lease.ts";
import { usedVars } from "./reuse.ts";

const REGISTRY = join(import.meta.dirname, "../../config/secrets.json");
const run = promisify(execFile);

function registry(): Registry {
  const raw = JSON.parse(readFileSync(REGISTRY, "utf8")) as Record<string, unknown>;
  delete raw._doc;
  return raw as Registry;
}

async function opRead(vault: string, item: string): Promise<Record<string, string>> {
  const { stdout } = await run("op", ["item", "get", item, "--vault", vault, "--reveal", "--format", "json"], { timeout: 90_000 });
  const fields = (JSON.parse(stdout).fields ?? []) as { label?: string; value?: string }[];
  return Object.fromEntries(fields.filter((f) => f.label && f.value).map((f) => [f.label!, f.value!]));
}

export default function (pi: ExtensionAPI) {
  const report = problems(pi, join(import.meta.dirname, "../../state/problems.log"));
  let ui: { hasUI?: boolean; ui: { notify(m: string, l?: "info" | "warning" | "error"): void } } | undefined;
  pi.on("session_start", (_e, ctx) => { ui = ctx as any; });
  const here = () => where({ pane: process.env.TMUX_PANE, cwd: process.cwd() });
  /** Told, not asked: every reuse is one line in this session and one no-action halo note (reuse is rare; never batched —
   *  a 10-min window once hid the worker handover behind a warm unlock, the one notice Yong most wanted). */
  const told = (name: string, via: string) => {
    const line = `🔑 ${name} reused → ${via}`;
    if (ui?.hasUI) ui.ui.notify(line, "info");
    postNote({ id: `secret:${name}:${via.split(" ")[0]}:${Date.now()}`, source: "pi-crew", title: line, body: `${here()} · no action needed` }, (k, m, e) => report.report(k, `secret-lease ${m}`, { error: e }));
  };
  /** A cold unlock is about to raise 1Password's dialog, which names "tmux", never the pi that asked (Yong 2026-09-21: "I've
   *  no idea what is requested and who is requesting it"). Say who and why first, so Cancel is an informed click. The pill card
   *  is an alert that lives exactly as long as the dialog (Yong 2026-09-22: a 6 s note was gone before he could read it). */
  const announce = (name: string): (() => void) => {
    const line = `🔑 unlocking ${name} · ${here()}`;
    const id = `secret:${name}:unlock:${Date.now()}`;
    const problem = (k: string, m: string, e?: unknown) => report.report(k, `secret-lease ${m}`, { error: e });
    if (ui?.hasUI) ui.ui.notify(`${line} — 1Password will ask for Touch ID`, "info");
    postAlert({ id, source: "pi-crew", title: line, body: `1Password's "allow tmux" dialog is this pi · Cancel it to refuse`, ttlMs: 3 * 60_000 }, problem);
    return () => retire({ id, source: "pi-crew", reason: "dialog closed" }, problem);
  };
  const lease = new Lease(registry, opRead, process.env, Date.now, (name) => told(name, "unlock (warm)"), processLedger());   // registry read per call: a new row needs no reload
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

  pi.on("tool_call", (e: any) => {
    if (e?.toolName !== "bash" || typeof e.input?.command !== "string") return;
    for (const name of usedVars(e.input.command, lease.leasedVars())) told(name, "bash");
  });
  // Is this ref leased right now? (crew's two-key list: a leased ref is mistake-class, a cold one reaches Yong)
  pi.events.on("secret:leased", (q: { ref: string; resolve: (name: string | undefined) => void }) => q.resolve(lease.valueFor(q.ref)?.name));
  // A crew worker's approved op consult: main answers from its own lease instead of a second Touch ID (crew performOperation).
  pi.events.on("secret:resolve", (q: { ref: string; worker?: string; resolve: (v: string | undefined) => void }) => {
    const hit = lease.valueFor(q.ref);
    if (hit) told(hit.name, `worker ${q.worker ?? "?"}`);
    q.resolve(hit?.value);
  });

  pi.registerTool({
    name: "secret_unlock",
    label: "Secret unlock",
    description:
      "Load a registered secret (config/secrets.json) into this pi process's env after Yong's Touch ID, memory only, fixed TTL. Returns the env var NAMES it set — never values. Use the vars in bash ($DEVIN_API_KEY); never echo them.",
    parameters: Type.Object({ name: Type.String({ description: "registry key, e.g. devin" }) }),
    async execute(_id, p) {
      const done = lease.isWarm(p.name) ? undefined : announce(p.name);   // BEFORE op: the 1Password dialog only ever says "tmux"
      try { return text(await lease.unlock(p.name)); } catch (e) { return text(`refused: ${(e as Error).message}`); } finally { done?.(); }
    },
  });

  pi.registerTool({
    name: "secret_lock",
    label: "Secret lock",
    description: "Forget a leased secret now (remove its env vars from this pi process).",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, p) { lease.lock(p.name); return text(`${p.name}: locked`); },
  });

  pi.registerCommand("secrets", {
    description: "Which secrets are leased in this pi process (names only)",
    handler: async (_a, ctx) => {
      const s = lease.status();
      ctx.ui.notify(s.length ? `leased:\n${s.join("\n")}` : "no secrets leased", "info");
    },
  });
}
