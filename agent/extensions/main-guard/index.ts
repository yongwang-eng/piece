// main-guard — enforces the standing rule "main never runs long blocking jobs" (AGENTS.md).
//
// Loads as a GLOBAL extension, i.e. into main only: fleet children run with global extensions off
// and load guard.ts explicitly, so a worker's backoff/poll loop is never touched by this file.
//
// The GUARANTEE is the deadline: `event.input` is mutable on `tool_call`, so the bash tool's own
// `timeout` (seconds) is clamped and pi kills the process tree at 60s no matter what the command
// is. The pattern layer is only a courtesy: it rejects the obvious explicit waits up front, in
// command position, with the async alternative. Nothing here bounds other tools (MCP calls).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MAIN_BASH_MAX_SECONDS = 60;
const SLEEP_TOLERATED_SECONDS = 10;

const ALTERNATIVE =
  "Main never blocks its own turn. Run the waiting job in a crew worker or detach it " +
  "(`nohup … > /tmp/<name>.log 2>&1 &`) and end your turn — the report/artifact arrives as a message; " +
  "then read the file when it does.";

// Where a command can start: line start, after ; & | && ||, or after `do`/`then`.
const CMD = String.raw`(?:^|[;&|]\s*|\b(?:do|then)\s+)`;
const WAIT_PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(String.raw`${CMD}(while|until)\b[^\n]*;\s*do\b[\s\S]*?\bsleep\b`, "m"), "poll loop"],
  [new RegExp(String.raw`${CMD}gh\s+run\s+watch\b`, "m"), "gh run watch"],
  [new RegExp(String.raw`${CMD}gh\s+(pr\s+checks|run\s+view)\b[^|;&\n]*--watch\b`, "m"), "gh --watch"],
  [new RegExp(String.raw`${CMD}tail\s+-[a-zA-Z]*[fF]\b`, "m"), "tail -f"],
  [new RegExp(String.raw`${CMD}watch\s+`, "m"), "watch"],
  [new RegExp(String.raw`${CMD}wait(\s+\S+)?\s*$`, "m"), "shell wait"],
  [new RegExp(String.raw`${CMD}waitfor\b`, "m"), "waitfor"],
];
const SLEEP = new RegExp(String.raw`${CMD}sleep\s+(\d+(?:\.\d+)?)`, "gm");

/** Drop heredoc bodies and quoted spans: text there is data, not a command. */
export function commandText(command: string): string {
  let out = command.replace(/<<-?\s*(["']?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, "<<HEREDOC");
  out = out.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  return out;
}

/** Pure policy: clamp the deadline, reject explicit waits. Exported for regression tests. */
export function mainBashPolicy(input: { command?: unknown; timeout?: unknown }): { block?: true; reason?: string; timeout?: number } {
  const command = typeof input.command === "string" ? input.command : "";
  if (!command.trim()) return {};
  const text = commandText(command);
  const sleeps = [...text.matchAll(SLEEP)].reduce((s, m) => s + Number(m[1]), 0);
  const hit = sleeps >= SLEEP_TOLERATED_SECONDS ? `sleep ${sleeps}s` : WAIT_PATTERNS.find(([re]) => re.test(text))?.[1];
  if (hit) return { block: true, reason: `BLOCKED by main-guard (${hit}): ${ALTERNATIVE}` };
  const requested = typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : MAIN_BASH_MAX_SECONDS;
  return { timeout: Math.min(requested, MAIN_BASH_MAX_SECONDS) };
}

export default function (pi: ExtensionAPI) {
  const clamped = new Set<string>();
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { command?: unknown; timeout?: unknown };
    const r = mainBashPolicy(input);
    if (r.block) return { block: true, reason: r.reason };
    if (r.timeout !== undefined) {
      if (typeof input.timeout !== "number" || input.timeout > r.timeout) clamped.add(event.toolCallId);
      input.timeout = r.timeout;
    }
  });
  // When the clamp is what killed the command, say so — bash alone reports "timed out after 60 seconds"
  // even though main may have asked for 600.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash" || !clamped.delete(event.toolCallId)) return;
    const text = (event.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    if (!/timed out/i.test(text)) return;
    return { content: [...event.content, { type: "text" as const, text: `\n[main-guard: this command was bounded to ${MAIN_BASH_MAX_SECONDS}s. ${ALTERNATIVE}]` }] };
  });
}
