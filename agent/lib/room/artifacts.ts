/**
 * Artifacts — what a crew run leaves behind that a human reads LATER (the vault), as opposed to the room's transport
 * record (`room.jsonl`, `consults.jsonl`, live only). Rule: if you would read it later or cite it, it is an artifact.
 *
 *   projects/proj_<slug>/crew_<slug>_<mmdd>/      ← when the run belongs to a project
 *   crews/crew_<slug>_<mmdd>/                     ← generic / no project
 *     plan.md                                     main writes at first spawn; appends roster changes + rulings
 *     final_report.md                             EXPECTED — the one self-contained read (a closing role writes it)
 *     wrap.md                                     EXPECTED — entry point, written last (outcome · verdict · follow-ups)
 *     <worker>/decisions.md                       runtime-appended via the worker's `decide` tool
 *     <worker>/deliverable.md                     the worker's own output
 *     <worker>/evidence/                          saved logs, diffs, screenshots (what consults cite)
 *     rounds/                                     evaluator rounds, cross-model reconciliation
 *
 * Names are snake_case throughout (vault convention: proj_pi_development, team_ci_course).
 *
 * Pure: no pi imports. The crew extension does the fs writes through `mkdirs`/`appendFile`-style callers here.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync } from "node:fs";
import { basename } from "node:path";

export const VAULT = process.env.PI_VAULT ?? `${process.env.HOME}/.pi/agent/artifacts`;

export function mmdd(d = new Date()): string {
  return `${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** `Consult id scope` → `consult_id_scope`; snake_case; ≤ 24 chars; never empty. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24).replace(/_+$/, "") || "run";
}

/** The owning project, if `cwd` is inside `projects/proj_<x>/…` of the vault. */
export function projectFromCwd(cwd: string): string | undefined {
  const m = new RegExp(`^${VAULT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/projects/(proj_[a-z0-9_-]+)(?:/|$)`, "i").exec(cwd);
  return m?.[1];
}

export interface ArtifactHome { dir: string; project?: string; name: string }

/**
 * Where this run's artifacts live. Explicit `project` wins; else inferred from main's cwd; else the generic `crews/`.
 * `slugText` is the human hint for the folder name (a task summary or the run's purpose), never the run id.
 */
export function artifactHome(p: { slugText: string; project?: string; cwd?: string; date?: Date; exists?: (dir: string) => boolean }): ArtifactHome {
  const project = p.project ?? (p.cwd ? projectFromCwd(p.cwd) : undefined);
  const base = `crew_${slug(p.slugText)}_${mmdd(p.date)}`;
  const root = project ? `${VAULT}/projects/${project}` : `${VAULT}/crews`;
  // Two crews, same slug, same day → `_2`, `_3`: a folder is never reused by a different run (its plan.md is another crew's contract).
  let name = base; for (let n = 2; p.exists?.(`${root}/${name}`); n++) name = `${base}_${n}`;
  return { dir: `${root}/${name}`, project, name };
}

// ── plan.md ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function planScaffold(p: { run: string; home: ArtifactHome; purpose: string; intake?: string; exitRule?: string; now?: Date }): string {
  const at = (p.now ?? new Date()).toISOString().slice(0, 16).replace("T", " ");
  return [
    `# Plan — ${p.home.name}`,
    ``,
    `> [!info] The contract every worker reads first`,
    `> Run \`${p.run}\` · ${p.home.project ? `project [[${p.home.project}]]` : "generic"} · started ${at}. Read this, then your own brief. Transport record (room/consults) lives in \`~/.pi/agent/workers/runs/${p.run}/\`, not here.`,
    ``,
    `## Purpose`,
    ``,
    p.purpose,
    ``,
    `## §Intake — what is already decided / known`,
    ``,
    p.intake ?? `_(main fills this at spawn: what's decided (with ruling ids), what's open, where things live, links. A worker that finds pre-existing work on disk should find its provenance HERE.)_`,
    ``,
    `## Exit rule`,
    ``,
    p.exitRule ?? `Every reviewer has replied \`result\` on the FINAL diff; \`final_report.md\` written by a closing role; \`wrap.md\` written last.`,
    ``,
    `## Roster`,
    ``,
    `| # | worker | role | owns |`,
    `|---|---|---|---|`,
    ``,
    `## Rounds & rulings`,
    ``,
    `_(append-only: consult decisions with their ids, mid-flight rulings, evaluator rounds)_`,
    ``,
  ].join("\n");
}

export function rosterRow(w: { id?: number; name: string; role?: string; responsibility: string }): string {
  const owns = w.responsibility.replace(/\s+/g, " ").trim();
  return `| ${w.id ?? "?"} | \`${w.name}\` | ${w.role ?? ""} | ${owns.length > 140 ? owns.slice(0, 139) + "…" : owns} |`;
}

/** Insert a roster row under the Roster table header (idempotent per worker name). */
export function addRosterRow(plan: string, row: string, name: string): string {
  if (plan.includes(`| \`${name}\` |`)) return plan;
  const marker = "|---|---|---|---|\n";
  const i = plan.indexOf(marker);
  if (i === -1) return plan + "\n" + row + "\n";
  const j = i + marker.length;
  return plan.slice(0, j) + row + "\n" + plan.slice(j);
}

/** A commit the run produced. Commits on a branch are reversible checkpoints; the RECORD of them is what must not be lost. */
export function commitLine(p: { at?: Date; sha: string; message: string; files: number; by: string; reviewers?: string[] }): string {
  const at = (p.at ?? new Date()).toISOString().slice(0, 16).replace("T", " ");
  return `| ${at} | \`${p.sha.slice(0, 7)}\` | ${p.by} | ${p.files} | ${p.message.replace(/\s+/g, " ").slice(0, 90)} | ${(p.reviewers ?? []).join(" ") || "—"} |`;
}

export function appendCommit(plan: string, line: string): string {
  const h = "## Commits";
  if (!plan.includes(h)) plan = plan.trimEnd() + `\n\n${h}\n\n| when | sha | by | files | message | approved by |\n|---|---|---|---|---|---|\n`;
  const i = plan.indexOf(h);
  const tableEnd = plan.indexOf("\n\n", plan.indexOf("|---|---|---|---|---|---|", i));
  const cut = tableEnd === -1 ? plan.length : tableEnd;
  return plan.slice(0, cut) + "\n" + line + plan.slice(cut);
}

export function rulingLine(p: { at?: Date; id: string; by: string; what: string }): string {
  const at = (p.at ?? new Date()).toISOString().slice(0, 16).replace("T", " ");
  return `- ${at} · **${p.id}** · ${p.by} — ${p.what.replace(/\s+/g, " ").trim()}`;
}

export function appendRuling(plan: string, line: string): string {
  const h = "## Rounds & rulings";
  const i = plan.indexOf(h);
  if (i === -1) return plan + `\n${h}\n\n${line}\n`;
  return plan.trimEnd() + "\n" + line + "\n";
}

// ── <worker>/decisions.md — the worker's "what I decided and why" ─────────────────────────────────────────────

export interface Decision { what: string; why: string; alternatives?: string; evidence?: string[]; at?: Date }

export function decisionsScaffold(name: string, role: string | undefined): string {
  return [
    `# ${name}${role && role !== name ? ` (${role})` : ""} — decisions`,
    ``,
    `> [!info] Appended by the worker's \`decide\` tool; reverse-chron. A non-obvious choice belongs here, not in prose.`,
    ``,
  ].join("\n");
}

export function decisionEntry(d: Decision): string {
  const at = (d.at ?? new Date()).toISOString().slice(0, 16).replace("T", " ");
  const lines = [`### ${at} — ${d.what.replace(/\s+/g, " ").trim()}`, ``, `**Why:** ${d.why.trim()}`];
  if (d.alternatives?.trim()) lines.push(``, `**Instead of:** ${d.alternatives.trim()}`);
  if (d.evidence?.length) lines.push(``, `**Evidence:** ${d.evidence.map((e) => `\`${e}\``).join(" · ")}`);
  lines.push(``);
  return lines.join("\n");
}

/** Insert at the top of the body (after the scaffold callout) — reverse-chron. */
export function prependDecision(file: string, entry: string): string {
  const marker = "\n\n";
  const calloutEnd = file.indexOf("\n\n", file.indexOf("> [!info]"));
  if (calloutEnd === -1) return file.trimEnd() + "\n\n" + entry;
  const j = calloutEnd + marker.length;
  return file.slice(0, j) + entry + "\n" + file.slice(j);
}

// ── fs glue (thin; the pure functions above are what tests cover) ───────────────────────────────────────────────────

export function ensureRunArtifacts(home: ArtifactHome, plan: string): { created: boolean } {
  const created = !existsSync(`${home.dir}/plan.md`);
  mkdirSync(`${home.dir}/rounds`, { recursive: true });
  if (created) writeFileSync(`${home.dir}/plan.md`, plan);
  return { created };
}

export function ensureWorkerArtifacts(home: ArtifactHome, name: string, role?: string): string {
  const dir = `${home.dir}/${name}`;   // worker folders sit directly in the run folder (no `workers/` level)
  mkdirSync(`${dir}/evidence`, { recursive: true });
  const f = `${dir}/decisions.md`;
  if (!existsSync(f)) writeFileSync(f, decisionsScaffold(name, role));
  return dir;
}

export function editPlan(home: ArtifactHome, edit: (plan: string) => string): void {
  const f = `${home.dir}/plan.md`;
  if (!existsSync(f)) return;
  const next = edit(readFileSync(f, "utf8"));
  writeFileSync(`${f}.tmp`, next); renameSync(`${f}.tmp`, f);   // sibling then rename — never in place
}

export function appendDecision(workerDir: string, d: Decision): void {
  const f = `${workerDir}/decisions.md`;
  const cur = existsSync(f) ? readFileSync(f, "utf8") : decisionsScaffold(basename(workerDir), undefined);
  writeFileSync(f, prependDecision(cur, decisionEntry(d)));
}

/** What is still expected of a run at close: the two files a human reads. */
export function missingAtClose(home: ArtifactHome): string[] {
  return ["final_report.md", "wrap.md"].filter((f) => {
    try { return !statSync(`${home.dir}/${f}`).isFile(); } catch { return true; }
  });
}


// ── lifetimes (D55): a worker is a lifetime; the work is the folder ─────────────────────────────────────────────────

export interface Predecessor {
  name: string; id?: number;
  diedAt?: string; reason?: string; tools?: number;
  folder: string;
  files: Array<{ name: string; bytes: number; lines: number; head: string }>;
  progress?: string;
  decisions: number; lastDecision?: string;
  lastMessages: string[];
}

/** Read a predecessor's folder into facts — no model, no interpretation. `roomTail` = its last room messages (main supplies). */
export function readPredecessor(folder: string, meta: { name: string; id?: number; diedAt?: string; reason?: string; tools?: number; roomTail?: string[] }): Predecessor {
  const files: Predecessor["files"] = [];
  let progress: string | undefined; let decisions = 0; let lastDecision: string | undefined;
  const list = (d: string, prefix = "") => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) { if (f.name === "evidence") { const n = countFiles(`${d}/${f.name}`); files.push({ name: `${prefix}evidence/`, bytes: 0, lines: n, head: `${n} files` }); } continue; }
      const p = `${d}/${f.name}`; const text = readFileSync(p, "utf8"); const lines = text.split("\n");
      const firstBody = lines.find((l) => l.trim() && !l.startsWith("---") && !/^\w[\w-]*:\s/.test(l)) ?? "";
      files.push({ name: prefix + f.name, bytes: Buffer.byteLength(text), lines: lines.length, head: firstBody.slice(0, 120) });
      if (f.name === "deliverable.md") { const m = lines.find((l) => /^progress:/i.test(l)); if (m) progress = m.replace(/^progress:\s*/i, "").trim(); }
      if (f.name === "decisions.md") { const heads = lines.filter((l) => l.startsWith("### ")); decisions = heads.length; lastDecision = heads[0]?.slice(4).trim(); }
    }
  };
  list(folder);
  return { name: meta.name, id: meta.id, diedAt: meta.diedAt, reason: meta.reason, tools: meta.tools, folder, files, progress, decisions, lastDecision, lastMessages: meta.roomTail ?? [] };
}

function countFiles(d: string): number { let n = 0; for (const f of readdirSync(d, { withFileTypes: true })) n += f.isDirectory() ? countFiles(`${d}/${f.name}`) : 1; return n; }

/** The RESUME block a successor's brief carries. Zero model work; every line is a fact from disk or the room. */
export function resumeBlock(p: Predecessor, successor: string): string[] {
  const kb = (b: number) => b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`;
  const out = [
    `RESUME — you are \`${successor}\`, the successor of \`${p.name}\`${p.id ? ` (#${p.id})` : ""}, which ${p.reason ? `died: ${p.reason}` : "ended"}${p.diedAt ? ` at ${p.diedAt.slice(11, 16)}` : ""}${p.tools !== undefined ? ` after ${p.tools} tool calls` : ""}.`,
    `Its work is on disk and is YOURS to continue — do not redo it. Folder: ${p.folder}`,
  ];
  for (const f of p.files) out.push(`  - ${f.name}${f.bytes ? ` · ${kb(f.bytes)} · ${f.lines} lines` : ""}${f.head && !f.name.endsWith("/") ? ` · "${f.head}"` : f.name.endsWith("/") ? ` · ${f.head}` : ""}`);
  if (p.progress) out.push(`Its last recorded progress: ${p.progress}`);
  else out.push(`It left no \`progress:\` line — read deliverable.md end-to-end to find where it stopped.`);
  if (p.decisions) out.push(`Its decisions.md has ${p.decisions} entr${p.decisions === 1 ? "y" : "ies"}; the latest: ${p.lastDecision}`);
  if (p.lastMessages.length) { out.push(`Its last room messages:`); for (const m of p.lastMessages.slice(-3)) out.push(`  > ${m.replace(/\s+/g, " ").slice(0, 200)}`); }
  out.push(`READ ITS deliverable.md FIRST. Continue from its progress line. Write your own work into YOUR folder (a sibling of its folder); cite its files rather than copying them. Put a \`progress:\` first line in your deliverable.md and refresh it as you go.`);
  return out;
}
