/**
 * Pure helpers for the telemetry extension — what we send, and what we strip first.
 * Mirrors ~/.claude/hooks/log_agent_activity.py so Claude Code and pi rows are comparable.
 * mac_hub redacts again at the API; this is the client half of belt-and-braces.
 */
const R = "[REDACTED]";
const ASSIGN =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|_KEY|CREDENTIAL)[A-Za-z0-9_]*|password|passwd|token|secret|api_key|apikey)=(?!\$)(?!\[REDACTED\])("[^"]*"|'[^']*'|[^\s;&|]+)/gi;
const TOKENS: RegExp[] = [
  /\bsk_(?:test|live)_[A-Za-z0-9]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj|live|svcacct)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?/g,
  /(?<=\bBearer\s)(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{20,}/g,
];

export function redact(text: string): string {
  if (!text) return text;
  let out = text.replace(ASSIGN, (_m, name: string, value: string) =>
    value.startsWith("op://") ? `${name}=${value}` : `${name}=${R}`,
  );
  for (const re of TOKENS) out = out.replace(re, R);
  return out;
}

const TRUNC = 600;
const t = (v: unknown, n = TRUNC): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return redact(s.length > n ? `${s.slice(0, n)}…` : s);
};

/** Small, redacted summary of how a tool was called — same keys the Claude hook emits. */
export function extractDetail(tool: string, args: unknown): Record<string, unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "bash":
      return { command: t(a.command) };
    case "read":
    case "write":
    case "edit":
      return { file_path: a.path ?? a.file_path };
    case "grep":
    case "find":
    case "ls":
      return { pattern: t(a.pattern ?? a.query, 200), path: a.path };
    default: {
      // MCP + unknown tools: keys only, plus a short redacted preview.
      const keys = Object.keys(a).slice(0, 8);
      return { keys, preview: t(a, 200) };
    }
  }
}

/** `/skill-name …` or `/skill-name` at the start of a user prompt → the skill name, else null. */
export function skillFromPrompt(text: string): string | null {
  const m = /^\s*\/([A-Za-z0-9][\w-]*)\b/.exec(text ?? "");
  return m ? m[1] : null;
}
