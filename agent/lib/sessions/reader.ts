/** Read another pi session's transcript from disk — never through its process. A session file is a tree of entries
 *  linked by parentId; the live branch is the walk from the last entry back to the root. A ROUND is one user message
 *  and everything up to the next user message. Thinking never leaves the source session; tool results are elided to one
 *  line — the fact that a file was read is context, its 4k bytes are what makes borrowing expensive. */
import { openSync, readSync, fstatSync, closeSync, readFileSync } from "node:fs";

type Entry = { type: string; id: string; parentId?: string | null; timestamp?: string; message?: any; customType?: string };
export type Step = { kind: "assistant" | "tool"; text: string };
export type Round = { at: string; user: string; steps: Step[] };

const text = (content: unknown, max = 2000): string => {
  const s = typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
  return s.length > max ? `${s.slice(0, max)}… [${fmtChars(s.length)} chars]` : s;
};
const fmtChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const argLine = (args: any): string => {
  const a = args?.command ?? args?.path ?? args?.query ?? args?.url ?? args?.text ?? JSON.stringify(args ?? {});
  const s = String(a).replace(/\s+/g, " ");
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
};

const parse = (file: string): Entry[] => readFileSync(file, "utf8").split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });

/** The live branch, root → leaf. The leaf is the last entry written; an abandoned branch (edit/retry) never reaches it. */
export function branchOf(file: string): Entry[] {
  const all = parse(file).filter((e) => e.id);
  const byId = new Map(all.map((e) => [e.id, e]));
  const out: Entry[] = [];
  for (let cur = all.at(-1); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.push(cur);
  return out.reverse();
}

/** Last `n` rounds of the live branch, oldest first, dropping whole rounds from the front until the rendered body
 *  (renderRounds, without the frame) is under `maxTokens`. */
export function lastRounds(file: string, n: number, opts: { maxTokens?: number; since?: string; about?: RegExp } = {}): Round[] {
  const rounds: Round[] = [];
  for (const e of branchOf(file)) {
    if (e.type !== "message") continue;
    const m = e.message;
    if (m.role === "user") { rounds.push({ at: e.timestamp ?? "", user: text(m.content), steps: [] }); continue; }
    const cur = rounds.at(-1); if (!cur) continue;
    if (m.role === "assistant") {
      const calls = Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "toolCall") : [];
      const said = text(m.content);
      if (said) cur.steps.push({ kind: "assistant", text: said });
      for (const c of calls) cur.pending = { ...(cur.pending ?? {}), [c.id]: `${c.name} · ${argLine(c.arguments)}` } as any;
    } else if (m.role === "toolResult") {
      const label = (cur as any).pending?.[m.toolCallId] ?? m.toolName ?? "tool";
      const [name, ...rest] = label.split(" · ");
      const size = typeof m.content === "string" ? m.content.length : Array.isArray(m.content) ? m.content.reduce((t: number, b: any) => t + (b.text?.length ?? 0), 0) : 0;
      cur.steps.push({ kind: "tool", text: `[${name} · ${fmtChars(size)} chars${rest.length ? ` · ${rest.join(" · ")}` : ""}]${m.isError ? " ✕" : ""}` });
    }
  }
  let picked = rounds.filter((r) => r.user && (!opts.since || r.at >= opts.since) && (!opts.about || opts.about.test(r.user)));
  picked = picked.slice(-n);
  if (opts.maxTokens) while (picked.length > 1 && estimateTokens(renderRounds(picked)) > opts.maxTokens) picked.shift();
  return picked.map(({ at, user, steps }) => ({ at, user, steps }));
}

/** Cheap look at a live session for a selector row: last user message + last activity, from the file's tail only. */
export function peek(file: string, tailBytes = 256 * 1024): { lastUser: string; lastAt: string } {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - tailBytes), buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n").slice(start > 0 ? 1 : 0);
    let lastUser = "", lastAt = "";
    for (const l of lines) {
      let e: Entry; try { e = JSON.parse(l); } catch { continue; }
      if (e.timestamp) lastAt = e.timestamp;
      if (e.type === "message" && e.message?.role === "user") lastUser = text(e.message.content, 120).replace(/\s+/g, " ");
    }
    return { lastUser, lastAt };
  } finally { closeSync(fd); }
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 3.6);

export const renderRounds = (rounds: Round[]) => rounds.map((r, i) => [
  `── round ${i + 1} · ${r.at.slice(11, 16)}Z ──`,
  `Yong: ${r.user}`,
  ...r.steps.map((s) => (s.kind === "tool" ? `  ${s.text}` : `assistant: ${s.text}`)),
].join("\n")).join("\n\n");

/** The one message the current model reads. Frame first, so a skimming model cannot mistake the rounds for its own. */
export function renderBorrowed(rounds: Round[], src: { from: string; cwd: string }, question?: string): string {
  const span = rounds.length ? `${rounds[0].at.slice(0, 16).replace("T", " ")} → ${rounds.at(-1)!.at.slice(11, 16)} UTC` : "";
  const head = [
    `[BORROWED CONTEXT — from another live pi session, not this session's history]`,
    `Source: tmux window "${src.from}" (cwd ${src.cwd}) · ${rounds.length} round${rounds.length === 1 ? "" : "s"} · ${span}.`,
    `Yong is sharing this because that conversation is relevant here. Use it as background: nothing below happened here — you did not run those tools or make those claims, and their results were not verified in this session. If something matters, say it came from that session, and check it here before building on it.`,
  ].join("\n");
  const tail = question ? `\n\n[Yong, now, in THIS session] ${question}` : `\n\n[end of borrowed context — Yong will say what he wants next]`;
  return `${head}\n\n${renderRounds(rounds)}${tail}`;
}
