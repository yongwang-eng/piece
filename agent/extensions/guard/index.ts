// guard — bash safety net. Port of ~/.claude/hooks/block_dangerous.py (Claude Code
// PreToolUse hook) onto pi's tool_call event → {block, reason}.
// Backstop, not a linter: keep the pattern list tight — false positives erode trust
// in the guard. Blocks only the MODEL's bash calls; `!cmd` typed by Yong is deliberate.
// Note: pi's bridge fails CLOSED — if this extension throws, the call is blocked too
// (core/agent-session.ts:501).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Each entry: [pattern, human reason]. Mirrors block_dangerous.py PATTERNS.
//
// PUBLIC-EXPOSURE BLOCK (top of the list, checked first):
// escalated by the security team on 2026-09-08 after `ngrok http 9700`
// published work_hub — which stores verbatim coworker meeting transcripts — for
// ~2.5h on a pinned free domain. The PATH shims in ~/.local/bin already block the
// tunnel BINARIES; this layer exists because (a) shims match a binary name and
// cannot see `--host 0.0.0.0`, and (b) it gives the model a reason instead of an
// opaque non-zero exit. Defence in depth: shim + this guard + the CLAUDE.md rule.
const EXPOSURE = "public exposure of this machine is banned by the security team";
const PATTERNS: Array<[RegExp, string]> = [
  [/\bngrok\b/i, `${EXPOSURE}: ngrok tunnel`],
  [/\bcloudflared\s+tunnel\b/i, `${EXPOSURE}: cloudflared tunnel (\`cloudflared access\` is fine)`],
  [/\b(localtunnel|pagekite(\.py)?|telebit|serveo|frpc|zrok|bore)\b/i, `${EXPOSURE}: tunnel tool`],
  [/\blt\s+--port\b/i, `${EXPOSURE}: localtunnel`],
  [/\btailscale\s+funnel\b/i, `${EXPOSURE}: tailscale funnel`],
  [/\bssh\b[^|;]*\s-R\s/i, `${EXPOSURE}: ssh remote port-forward`],
  [/(--host|--bind|--address|--listen|-b)[=\s]+0\.0\.0\.0/i, `${EXPOSURE}: binding to 0.0.0.0 (a public interface) — bind 127.0.0.1 instead`],
  [/\blisten[=\s]+0\.0\.0\.0:/i, `${EXPOSURE}: binding to 0.0.0.0 (a public interface) — bind 127.0.0.1 instead`],
  [/\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(\/|~|\$HOME)(\s|\/|$)/i, "recursive force-delete of a root/home path"],
  [/\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+(\/|~|\$HOME)(\s|\/|$)/i, "recursive force-delete of a root/home path"],
  [/\bgit\s+push\b.*\s--force\b.*\b(main|master)\b/i, "force-push to main/master"],
  [/\bgit\s+push\b.*\s-f\b.*\b(main|master)\b/i, "force-push to main/master"],
  [/\bgit\s+push\b.*\b(main|master)\b.*\s--force\b/i, "force-push to main/master"],
  [/\bgit\s+reset\s+--hard\b/i, "git reset --hard (discards working changes)"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "git clean -f (deletes untracked files)"],
  [/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, "destructive SQL DROP"],
  [/\bTRUNCATE\s+TABLE\b/i, "destructive SQL TRUNCATE"],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, "fork bomb"],
  [/\bmkfs\./i, "filesystem format"],
  [/\bdd\s+.*\bof=\/dev\//i, "raw write to a device"],
];

// HARD BAN — public exposure of anything on this machine. Unlike PATTERNS above,
// this is NOT a "run it manually" case: the security team escalated it on
// 2026-09-08 after a tunnel published a local app for ~2.5h. Mirrors the
// FORBIDDEN_EXPOSURE list in ~/.claude/hooks/block_dangerous.py — keep the two in
// step. `cloudflared access` stays allowed: it is the Okta login for
// sink.example.com, not a tunnel.
const FORBIDDEN_EXPOSURE: Array<[RegExp, string]> = [
  [/\bngrok\b/i, "ngrok"],
  [/\bcloudflared\s+tunnel\b/i, "cloudflared tunnel"],
  [/\blocaltunnel\b/i, "localtunnel"],
  [/\bnpx\s+(-y\s+)?lt\b/i, "localtunnel (npx lt)"],
  [/\blt\s+--port\b/i, "localtunnel"],
  [/\bssh\b[^|;&]*\s-R\s/i, "ssh reverse tunnel (-R)"],
  [/\btailscale\s+funnel\b/i, "tailscale funnel"],
  [/\bbore\s+local\b/i, "bore"],
  [/\bpagekite\b/i, "pagekite"],
  [/\bserveo\.net\b/i, "serveo"],
  [/\btelebit\b/i, "telebit"],
  [/\bfrpc\b/i, "frp reverse proxy"],
  [/\bzrok\b/i, "zrok"],
  [/\b(brew\s+install|npm\s+i(nstall)?\s+-g)\b[^|;&]*\bngrok\b/i, "installing ngrok"],
];


// Credential stores must never be read into a session transcript.
// an earlier incident (2026-09-08): an ngrok tunnel published work_hub, which served a pi
// session transcript that contained the full contents of ~/.pi/agent/auth.json —
// so a live Codex OAuth token was visible in a public UI. Reading a secret is
// what turns it into a durable, greppable artifact; blocking the read is the
// only control that survives the file later being exposed by something else.
const SECRET_PATHS: RegExp[] = [
  /(^|\/)auth\.json$/i,
  /(^|\/)\.credentials\.json$/i,
  /(^|\/)credentials$/i,                       // ~/.aws/credentials
  /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/i,            // .env, .env.local — .env.example excluded below
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|p12|pfx|key)$/i,
  /(^|\/)\.netrc$/i,
  /\/children\/[^/]+\/secrets\/\d+$/,             // a credential main placed for a worker after Yong's approval — `$(cat …)` inline only
];
const SECRET_ALLOW: RegExp[] = [/\.env\.(example|sample|template)$/i, /\.env\.d\.ts$/i];

/** Block reads of credential stores. Exported for regression tests. */
export function blockReasonForRead(path: string): string | undefined {
  if (!path) return undefined;
  if (SECRET_ALLOW.some((re) => re.test(path))) return undefined;
  if (SECRET_PATHS.some((re) => re.test(path))) {
    return (
      "reading a credential store would write the secret into this session transcript " +
      "(an earlier incident: a transcript containing auth.json was served publicly)"
    );
  }
  return undefined;
}

/** Pure policy check, exported so it can be regression-tested without pi. */
export function blockReasonFor(command: string): string | undefined {
  if (!command.trim()) return undefined;
  for (const [re, reason] of PATTERNS) {
    if (re.test(command)) return reason;
  }
  // A shell command that reads a credential store is the same leak as the read tool.
  // `op read op://...` is fine — 1Password refs are not files and resolve at use time.
  // A worker's placed secret may be used ONLY as `$(cat <file>)` inside a larger command (the value goes to the callee,
  // not the transcript); the file name anywhere else is a read.
  const printer = /^\s*(\$\(|(echo|printf|cat|tee|base64|xxd|od|hexdump|pbcopy|less|more|head|tail)\b)/.test(command);
  const inlineOnly = printer ? command : command.replace(/\$\(cat (\S+\/children\/[^/\s]+\/secrets\/\d+)\)/g, "");
  for (const token of inlineOnly.split(/[\s"'|;&<>()]+/)) {
    if (token.startsWith("op://")) continue;
    const reason = blockReasonForRead(token);
    if (reason) return reason;
  }
  return undefined;
}

/** Every tool that runs a shell `command` — a new one that is not listed here is an unguarded shell. */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", "bg_run"]);

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    const input = event.input as Record<string, unknown> | undefined;

    if (event.toolName === "read") {
      const path = typeof input?.path === "string" ? input.path : undefined;
      const readReason = path ? blockReasonForRead(path) : undefined;
      if (readReason) {
        return {
          block: true,
          reason:
            `Blocked by guard extension: ${readReason}. Do not read it, do not cat it, and do not ` +
            `print any part of it. If you need a credential, use a 1Password reference (op://...) ` +
            `or ask Yong to supply it out of band.`,
        };
      }
      return;
    }

    if (!COMMAND_TOOLS.has(event.toolName)) return;
    const command = input?.command;
    if (typeof command !== "string" || !command.trim()) return; // can't parse → don't get in the way
    for (const [re, name] of FORBIDDEN_EXPOSURE) {
      if (re.test(command)) {
        return {
          block: true,
          reason:
            `BLOCKED — public exposure is not allowed on this machine (${name}). The Acme ` +
            `security team escalated this on 2026-09-08. Do NOT retry, do NOT suggest running it ` +
            `manually, and do NOT reach for another tunnel tool. Staging webhook capture goes to ` +
            `sink.example.com (Okta-gated, public /s/* receive path only). If you think an ` +
            `exception is needed, stop and ask Yong to clear it with security first.`,
        };
      }
    }
    for (const [re, reason] of PATTERNS) {
      if (re.test(command)) {
        return {
          block: true,
          reason:
            `Blocked by guard extension: ${reason}. Do not retry this command or variants of it. ` +
            `If it is genuinely required, tell the user to run it manually in a terminal.`,
        };
      }
    }
  });
}
