/**
 * Pure tmux/argv helpers for crew — no side effects, no pi imports, unit-tested.
 *
 * Panes are addressed by id (`%N`), never by index: indexes shift when any pane
 * closes and a wrong index kills someone else's shell.
 */
import { homedir } from "node:os";

export interface SpawnSpec {
  /** "browser" = shared CLI browser tool with identity leases. */
  mcp?: "browser";
  /** MCP servers granted via `needs` (`<server>:read`, D79); non-empty loads the adapter. The `--tools` allowlist is the enforcement. */
  mcpServers?: string[];
  name: string;
  run: string;
  cwd: string;
  profile?: string;
  model?: string;
  tools?: string;
  /** one line peers read to decide whether to ask me (D42); defaults to the profile name */
  role?: string;
  /** what I OWN in this run — the task text */
  responsibility?: string;
  /** stable #N — the worker's colour derives from it on every surface */
  id?: number;
  /** vault folder for this worker's artifacts (decisions.md, deliverable.md, evidence/) */
  artifactsDir?: string;
  /** the run's plan.md — the contract every worker reads first */
  planPath?: string;
  /** roles this worker may address (main always); absent = anyone */
  talksTo?: string[];
  /** preset files to append after the constitution: profiles/<role>/{AGENTS,CREW}.md, whichever exist */
  presetFiles?: string[];
  agentDir: string;              // ~/.pi/agent
  briefPath: string;
  sessionDir: string;
  /** Standing rules every worker of every backend gets (~/.pi/agent/workers/constitution.md). */
  constitutionPath: string;
}

/** POSIX single-quote shell escaping. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}


/**
 * Curated worker extension list (D33): no fleet, no main-guard, no global discovery.
 *
 * Loading an extension is not enough: its tool names must also enter `--tools` or the worker cannot call them.
 */
export function workerExtensions(agentDir: string, mcp?: "browser", mcpServers: string[] = []): string[] {
  const list = [
    // NO ask-user: a worker reaching Yong through its own picker bypasses classification, the governor, the evidence packet
    // and the audit log. On 2026-09-11 the implementer did exactly that and got an answer contradicting main's — two
    // "human answers" on one question, neither traceable. A worker reaches Yong through `consult` or not at all.
    `${agentDir}/extensions/crew/runtime/worker.ts`,
    `${agentDir}/extensions/usage/index.ts`,
    // background compaction lives in the pi-background-compact package (service + trigger, one entry)
    `${homedir()}/.pi/packages/pi-background-compact/extensions/background-compact.ts`,
    `${agentDir}/extensions/guard/index.ts`,
    `${agentDir}/extensions/compact-tools/index.ts`,
    `${agentDir}/extensions/thought-ticker/index.ts`,
    // no compact-footer: crew/runtime/worker.ts owns the footer so identity (#N name · role) leads it
  ];
  if (mcp === "browser") list.push(`${agentDir}/extensions/crew/runtime/browser.ts`);
  // The adapter connects every configured server; only the `--tools` allowlist (generated from config/mcp_tools.json) decides
  // what the worker can call. Loading it without an allowlist would expose the `mcp` gateway — spawn refuses that combination.
  else if (mcpServers.length) list.push(`${agentDir}/npm/node_modules/pi-mcp-adapter/index.ts`);
  return list;
}

/** `hubmcp_search_datadog_logs` with server `hubmcp` → `hubmcp/search_datadog_logs`: the adapter's direct-tool selector. */
export function directToolSelectors(tools: string | undefined, servers: string[]): string[] {
  const out: string[] = [];
  for (const t of (tools ?? "").split(",").map((x) => x.trim()).filter(Boolean))
    for (const srv of servers) if (t.startsWith(`${srv}_`)) { out.push(`${srv}/${t.slice(srv.length + 1)}`); break; }
  return out;
}

/** The full shell command tmux runs in the worker pane. */
export function workerCommand(s: SpawnSpec): string {
  const env = [
    `PI_CREW_ROLE=worker`,
    `PI_CREW_NAME=${shq(s.name)}`,
    `PI_CREW_RUN=${shq(s.run)}`,
    `PI_CREW_BRIEF=${shq(s.briefPath)}`,
    `PI_CREW_ROLE_LINE=${shq(s.role ?? s.profile ?? "worker")}`,
    `PI_CREW_RESPONSIBILITY=${shq(s.responsibility ?? "")}`,
    `PI_CREW_ARTIFACTS=${shq(s.artifactsDir ?? "")}`,
    `PI_CREW_PLAN=${shq(s.planPath ?? "")}`,
    `PI_CREW_TALKS_TO=${shq((s.talksTo ?? []).join(","))}`,
    `PI_CREW_PROFILE=${shq(s.profile ?? "")}`,
    `PI_CREW_ID=${shq(String(s.id ?? ""))}`,
    `PI_CREW_MODEL=${shq(s.model ?? "")}`,
  ];
  // The adapter hides every MCP tool behind the `mcp` gateway unless told to register them directly. A grant that
  // only allowlists `hubmcp_search_datadog_logs` in --tools therefore names a tool that does not exist (EXP-011).
  const direct = directToolSelectors(s.tools, s.mcpServers ?? []);
  if (direct.length) env.push(`MCP_DIRECT_TOOLS=${shq(direct.join(","))}`);
  const envStr = env.join(" ");
  // --no-themes: pi otherwise prints every installed theme name at startup (a wall of text in a 40-col pane)
  // --no-approve: a cwd with .pi/ or .agents/skills otherwise raises the project-trust prompt in a pane nobody
  // answers, and the spawn dies at startup; project-local files are already excluded by the --no-* flags above.
  const args: string[] = ["pi", "-n", shq(s.name), "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-approve"];
  for (const e of workerExtensions(s.agentDir, s.mcp, s.mcpServers)) args.push("-e", shq(e));
  // Order is the precedence: standing rules, then role, then this task. `--no-context-files` means the
  // human's global AGENTS.md is absent by design, so the constitution is the ONLY source of the
  // never-notify / never-send / no-tunnel rules — a worker without it has full tools and no law.
  args.push("--append-system-prompt", shq(s.constitutionPath));
  // A preset = profiles/<role>/AGENTS.md (the craft) + CREW.md (the room layer); both appended when they exist.
  for (const f of s.presetFiles ?? []) args.push("--append-system-prompt", shq(f));
  args.push("--append-system-prompt", shq(s.briefPath));
  args.push("--session-dir", shq(s.sessionDir));
  if (s.model) args.push("--model", shq(s.model));
  if (s.tools) args.push("--tools", shq(s.tools));
  // `; read` keeps the pane open on crash so the error stays readable instead of vanishing.
  return `cd ${shq(s.cwd)} && ${envStr} ${args.join(" ")}; echo; echo '[crew] worker exited — press enter to close'; read`;
}

/** argv for the first worker: split main hubmcptally, worker takes the right 40%, main keeps focus. */
export function splitFirstArgs(mainPane: string, command: string): string[] {
  return ["split-window", "-h", "-d", "-p", "40", "-P", "-F", "#{pane_id}", "-t", mainPane, command];
}

/** argv for subsequent workers: split the last worker pane vertically (stack in the right column). */
export function splitNextArgs(anchorPane: string, command: string): string[] {
  return ["split-window", "-v", "-d", "-P", "-F", "#{pane_id}", "-t", anchorPane, command];
}

/** Equalize the right column after spawn/kill only — never on events (manual resize wins). */
export function equalizeArgs(mainPane: string, windowWidth: number): string[][] {
  const mainWidth = Math.max(40, Math.round(windowWidth * 0.6));
  return [
    ["select-layout", "-t", mainPane, "main-vertical"],
    ["resize-pane", "-t", mainPane, "-x", String(mainWidth)],
  ];
}

export function killArgs(pane: string): string[] {
  return ["kill-pane", "-t", pane];
}

export function isPaneId(s: string): boolean {
  return /^%\d+$/.test(s.trim());
}

/** `/crew_cli spawn <name> [--profile p] [--role "one line"] [--model m] [--run r] [--tools t] [--cwd dir] -- <task>` */
/** One name per worker: the role IS the name (slugified; a second `reviewer` becomes `reviewer-2`). An explicit
 *  leading token is still accepted as an override. `role` is kept on the card for routing (`room_who`), never displayed twice. */
const KNOWN_FLAGS = new Set(["--role", "--profile", "--model", "--run", "--tools", "--cwd", "--project", "--slug", "--talks-to", "--intake"]);
export function parseSpawn(rest: string[]): { name?: string; profile?: string; role?: string; model?: string; run?: string; tools?: string; cwd?: string; project?: string; intake?: string; slug?: string; talksTo?: string[]; task: string } | { error: string } {
  const sep = rest.indexOf("--");
  const head = sep === -1 ? rest : rest.slice(0, sep);
  const task = sep === -1 ? "" : rest.slice(sep + 1).join(" ").trim();
  const usage = "usage: /crew_cli spawn [name] --role <one line> [--profile p] [--model m] [--run r] [--tools t] [--cwd dir] [--project proj_x] [--slug folder_name] [--talks-to role,role] [--intake <what's decided>] -- <task>";
  let name: string | undefined; let flags = head;
  if (head[0] && !head[0].startsWith("--")) { name = head[0]; flags = head.slice(1); }
  if (name && !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)) return { error: `bad worker name "${name}" (letters, digits, - _; ≤32)` };
  const out: any = { task }; if (name) out.name = name;
  for (let i = 0; i < flags.length; i += 2) {
    const k = flags[i];
    let v = flags[i + 1];
    if (!v) return { error: `flag ${k} needs a value` };
    if (k === "--intake") {                      // multi-word; stops at the next KNOWN flag (the text may contain `--test`, `--no-x`…)
      const words = [v]; let j = i + 2;
      while (j < flags.length && !KNOWN_FLAGS.has(flags[j])) words.push(flags[j++]);
      out.intake = words.join(" ").replace(/^["']|["']$/g, ""); i = j - 2; continue;
    }
    if (k === "--role") {                        // multi-word: consume until the next KNOWN flag
      const words = [v]; let j = i + 2;
      while (j < flags.length && !KNOWN_FLAGS.has(flags[j])) words.push(flags[j++]);
      out.role = words.join(" ").replace(/^["']|["']$/g, ""); i = j - 2; continue;
    }
    if (k === "--profile") out.profile = v;
    else if (k === "--model") out.model = v;
    else if (k === "--run") out.run = v;
    else if (k === "--tools") out.tools = v;
    else if (k === "--cwd") out.cwd = v;
    else if (k === "--project") out.project = v.startsWith("proj_") ? v : `proj_${v}`;
    else if (k === "--slug") out.slug = v;
    else if (k === "--talks-to") out.talksTo = v.split(",").map((x) => x.trim()).filter(Boolean);
    else return { error: `unknown flag ${k}` };
  }
  if (!name && !out.role && !out.profile) return { error: usage + "  (a --role or --profile names the worker)" };
  if (!task) return { error: "missing task: put it after `--`" };
  return out;
}

/** `doc owner` → `doc-owner`; `Test-Suite Auditor` → `test-suite-auditor`. */
export function slugName(role: string): string {
  return role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "worker";
}

/** First free of `base`, `base-2`, `base-3`… against the names already taken. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const t = new Set(taken);
  if (!t.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const c = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!t.has(c)) return c;
  }
}

/**
 * INVARIANT: nothing in crew moves Yong's focus. Every argv that could is refused at the wrapper.
 *   select-pane   — ALL forms select (even -T / -P, which look like pure style setters; that one stole focus on every
 *                   presence repaint until 2026-09-10)
 *   select-window · switch-client · next/previous-window/layout — change the visible window/client
 *   split-window without -d · new-window without -d — focus the new pane
 * Style → `set-option -p pane-border-style`; title → the worker's own OSC 2 (pi setTitle); layout → select-layout (verified
 * live not to move focus); kill-pane -t <other> leaves focus where it is.
 */
export function focusMovingVerb(args: string[]): string | undefined {
  const verb = args[0];
  if (!verb) return undefined;
  if (["select-pane", "select-window", "switch-client", "next-window", "previous-window", "last-window", "last-pane", "next-layout", "previous-layout"].includes(verb)) return verb;
  if ((verb === "split-window" || verb === "new-window") && !args.includes("-d")) return `${verb} (without -d)`;
  return undefined;
}

/** The preset behind a role: `profiles/<slug(role)>/{AGENTS.md,CREW.md}` — whichever exist, in that order. Empty = ad-hoc role. */
export function presetFiles(agentDir: string, role: string | undefined, exists: (p: string) => boolean): string[] {
  if (!role) return [];
  const dir = `${agentDir}/profiles/${slugName(role)}`;
  return [`${dir}/AGENTS.md`, `${dir}/CREW.md`].filter(exists);
}

/**
 * `reads:` lines in a preset's CREW.md name the claude_context kernels this role always needs — PATHS, read on demand,
 * never pasted. Format: a line `reads: a.md, b.md` (vault-relative to resources/claude_context/, or absolute).
 */
export function presetReads(crewMd: string, vault: string): string[] {
  const m = /^reads:\s*(.+)$/im.exec(crewMd);
  if (!m) return [];
  return m[1].split(",").map((x) => x.trim()).filter(Boolean).map((f) => f.startsWith("/") || f.startsWith("~") ? f : `${vault}/resources/claude_context/${f.endsWith(".md") ? f : f + ".md"}`);
}
