/**
 * telemetry — mirror every tool call and slash-skill into mac_hub's agent_activities log,
 * tagged source:"pi", so /workflow-improver sees pi and Claude Code side by side.
 *
 * Wire format matches ~/.claude/hooks/log_agent_activity.py. Adds what the hook can't:
 * real ok (isError), duration_ms (start→end), and the model in use.
 *
 * Fire-and-forget: a 1.5 s fetch with no await on the turn. If mac_hub is down, nothing happens.
 * Redaction happens client-side (detail.ts) AND at the API — a usage log must never hold a secret.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractDetail, skillFromPrompt } from "./detail.ts";

const ENDPOINT = process.env.MAC_HUB_ACTIVITY_URL ?? "http://127.0.0.1:9300/api/agent_activities";

type Row = {
  kind: "tool" | "skill";
  name: string;
  session_id: string | null;
  cwd: string | null;
  detail: unknown;
  ok: boolean | null;
  source: "pi";
  duration_ms?: number;
  model?: string | null;
};

function send(row: Row): void {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(row),
    signal: ac.signal,
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
}

export default function telemetry(pi: ExtensionAPI) {
  const started = new Map<string, { t0: number; args: unknown }>();
  const base = (ctx: any) => ({
    session_id: ctx.sessionManager?.getSessionId?.() ?? null,
    cwd: ctx.sessionManager?.getCwd?.() ?? process.cwd(),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
  });

  pi.on("tool_execution_start", (event) => {
    started.set(event.toolCallId, { t0: Date.now(), args: event.args });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const s = started.get(event.toolCallId);
    started.delete(event.toolCallId);
    send({
      kind: "tool",
      name: event.toolName,
      detail: extractDetail(event.toolName, s?.args),
      ok: !event.isError,
      source: "pi",
      ...(s ? { duration_ms: Date.now() - s.t0 } : {}),
      ...base(ctx),
    });
  });

  pi.on("input", (event, ctx) => {
    const skill = skillFromPrompt(event.text);
    if (!skill) return;
    send({ kind: "skill", name: skill, detail: { via: "slash-command" }, ok: true, source: "pi", ...base(ctx) });
  });
}
