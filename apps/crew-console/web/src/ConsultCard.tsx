import { useState, type ReactNode } from "react";
import { Bot, CircleCheck, CornerDownRight, FileText, User } from "lucide-react";
import { answer, getEvidence, ago, clock, type Consult, type Evidence } from "./api.ts";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CLASS_TONE, KV } from "./ui.tsx";

const HEADLINE: Record<string, (c: Consult) => string> = {
  auth: (c) => `${c.worker} asks you to sign in`,
  notify: (c) => `${c.worker} wants to notify someone`,
  money: (c) => `${c.worker} wants to spend`,
};
const headline = (c: Consult) => HEADLINE[c.class]?.(c) ?? (c.action ? `${c.worker} wants to ${c.action.verb}` : `${c.worker} needs your decision`);
/** the ONE filled button per card: the recommended option, else the class's affirmative */
/** Main's recommendation ("approve · approve, amended (…) · ask first (…) · reject") resolved to a key this card actually offers. */
export const recommendedKey = (rec: string | undefined, keys: string[]): string | undefined => {
  const r = (rec ?? "").trim().toLowerCase();
  if (!r) return undefined;
  const want = r.startsWith("approve, amended") ? "amend" : r.startsWith("approve") ? "approve" : r.startsWith("ask first") ? "ask" : r.startsWith("reject") ? "reject" : undefined;
  if (want && keys.includes(want)) return want;
  return keys.includes("answer") ? "answer" : undefined;          // no matching button: the human states it in his own words, prefilled with main's text
};
const primaryKey = (c: Consult) => {
  const keys = (c.options ?? []).map((o) => o.key);
  return c.options?.find((o) => o.recommended)?.key ?? recommendedKey(c.packet?.assessment?.recommendation, keys) ?? c.options?.find((o) => ["approve", "self", "intent"].includes(o.key))?.key;
};

/** One turn of the thread: an avatar column, a name/time line, the body. Human turns are tinted; the worker's are plain. */
function Turn({ who, name, at, pending, children }: { who: "worker" | "human"; name: string; at?: string | number; pending?: boolean; children: ReactNode }) {
  const human = who === "human";
  return (
    <li className={cn("flex gap-3 px-4 py-3", human && "bg-accent/40")}>
      <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border", human ? "border-signal/30 bg-signal/10 text-signal" : "border-border bg-secondary text-muted-foreground")}>
        {human ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 font-mono text-[11px]">
          <span className={cn("truncate font-medium", human ? "text-signal" : "text-foreground")}>{name}</span>
          {at !== undefined && <span className="shrink-0 tabular-nums text-muted-foreground">{clock(at)}</span>}
          {pending && <span className="live-dot text-muted-foreground">is replying…</span>}
        </div>
        {!pending && <div className="mt-1 space-y-2.5 text-[13px]">{children}</div>}
      </div>
    </li>
  );
}

export function ConsultCard({ c, now, onAnswered }: { c: Consult; now: number; onAnswered: (id: string) => void }) {
  const [pending, setPending] = useState<string | null>(null);   // choice awaiting its follow-up text
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null | "loading">(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (choice: string, t?: string) => {
    setBusy(true); setError(null);
    try { const r = await answer(c.run, c.id, choice, t); if (r.choice === "ask") { setPending(null); onAnswered(c.id); } else { setDone(r.choice); setTimeout(() => onAnswered(c.id), 700); } }
    catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  };
  const pick = (key: string) => {
    if (key === "show") { if (evidence === null) { setEvidence("loading"); getEvidence(c.run, c.id).then(setEvidence).catch(() => setEvidence(null)); } else setEvidence(null); return; }
    if (c.followUp?.[key]) { setPending(key); setText(key === "answer" && key === primary ? (c.packet?.assessment?.recommendation ?? "") : ""); return; }
    void submit(key);
  };
  const waiting = c.thread.at(-1)?.who === "human";
  const primary = primaryKey(c);
  const opts = (c.options ?? []).filter((o) => o.key !== primary);
  const p = c.packet ?? {};

  // Evaluate first, then show: until main has written the packet (governor briefing + its own assessment) there is
  // nothing to decide on — a quiet row says so instead of a card that grows a recommendation in the middle.
  if (!c.packet) {
    return (
      <Card className="overflow-hidden opacity-80">
        <div className="flex items-center gap-3 px-4 py-3 text-[13px]">
          <span className="live-dot text-muted-foreground" />
          <span className="font-mono text-[11px] text-muted-foreground">{c.run} · {c.worker}</span>
          <Badge variant={CLASS_TONE[c.class] ?? "neutral"}>{c.class}</Badge>
          <span className="truncate">{c.question}</span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">main is evaluating… · {ago(now - c.askedAt)}</span>
        </div>
      </Card>
    );
  }

  return (
    <Card accent="signal" className={cn("overflow-hidden", done && "settled")}>
      {/* ── header: who · what class · how long ── */}
      <header className="flex items-start justify-between gap-4 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span>{c.run}</span><span>·</span><span className="truncate">{c.worker}</span>
            <Badge variant={CLASS_TONE[c.class] ?? "neutral"}>{c.class}</Badge>
            {c.followUpOf && <Badge variant="info"><CornerDownRight />follow-up of {c.followUpOf}</Badge>}
            {p.preauthorized && <Badge variant="neutral">pre-authorized</Badge>}
          </div>
          <h3 className="mt-1 text-[16px] font-semibold tracking-tight">{headline(c)}</h3>
        </div>
        <span className={cn("shrink-0 font-mono text-[11px] tabular-nums", waiting ? "text-muted-foreground" : "text-signal")}>open {ago(now - c.askedAt)}</span>
      </header>

      {/* ── the thread: the ask is turn 1, then every exchange, then the pending reply ── */}
      <ol className={cn("divide-y divide-border border-t border-border", waiting && "opacity-80")}>
        <Turn who="worker" name={c.worker} at={c.askedAt}>
          <p className="text-[14px] leading-snug">{c.question}</p>
          {c.action && (
            <p className="font-mono text-[12px]"><span className="text-muted-foreground">act </span><span className="font-medium">{c.action.verb} — {c.action.target}</span>{c.action.detail && <span className="text-muted-foreground"> · {c.action.detail}</span>}</p>
          )}
          {c.intent && (
            <KV rows={[["why", c.intent.why], ["exact", c.intent.exact && <span className="font-mono text-[12px] whitespace-pre-wrap">{c.intent.exact}</span>], ["effect", c.intent.effect], ["reversible", c.intent.reversible], ["if denied", c.intent.ifDenied]]} />
          )}
          <KV rows={[
            ["why yours", p.whyHuman],
            ["rephrased", p.question && p.question !== c.question ? p.question : null],

            ["decided", p.priorDecisions?.length ? <ul className="space-y-0.5">{p.priorDecisions.map((d, i) => <li key={i} className="text-muted-foreground">{d}</li>)}</ul> : null],
            ["evidence", c.evidence.length ? <span className="font-mono text-[12px] text-muted-foreground">{c.evidence.join(" · ")}</span> : null],
          ]} />
        </Turn>
        {c.reply && <Turn who="worker" name={`${c.worker} · answering ${c.followUpOf}`}><p className="whitespace-pre-wrap">{c.reply}</p></Turn>}
        {c.thread.map((t, i) => <Turn key={i} who={t.who} name={t.who === "human" ? "you" : c.worker} at={t.at}><p className="whitespace-pre-wrap">{t.text}</p></Turn>)}
        {waiting && <Turn who="worker" name={c.worker} pending>{null}</Turn>}
      </ol>

      {/* ── evidence drawer (the "show" option) ── */}
      {evidence && (
        <div className="fade-in border-t border-border bg-muted/40 px-4 py-3 text-[12px]">
          {evidence === "loading" ? <span className="text-muted-foreground">loading…</span> : (
            <div className="grid gap-3 md:grid-cols-2">
              <div><div className="mb-1 inline-flex items-center gap-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"><FileText className="size-3" />brief.md</div><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-2 font-mono text-[11px]">{evidence.brief ?? "(none)"}</pre></div>
              <div><div className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">room · last {evidence.roomTail.length}</div>
                <ol className="max-h-64 space-y-1 overflow-auto rounded-md border border-border bg-card p-2 font-mono text-[11px]">{evidence.roomTail.map((m, i) => <li key={i}><span className="text-muted-foreground/70">{m.from}→{m.to.join(",")}</span> <span className="text-muted-foreground">{m.kind}</span> {m.text.slice(0, 160)}</li>)}</ol></div>
            </div>
          )}
        </div>
      )}

      {/* ── main's judgment: the last thing read before the buttons ── */}
      {!done && (p.assessment || p.recommendation) && (
        <div className={cn("mx-4 my-4 rounded-md border-l-[3px] px-4 py-3", !p.assessment ? "border-border bg-muted/40" : p.assessment.risk === "high" ? "border-destructive bg-destructive/5" : p.assessment.risk === "medium" ? "border-warn bg-warn/5" : "border-ok bg-ok/5")}>
          {p.assessment ? (
            <>
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">main recommends</span>
                <span className="text-[15px] font-semibold">{p.assessment.recommendation}</span>
                <span className={cn("ml-auto font-mono text-[11px] uppercase", p.assessment.risk === "high" ? "text-destructive" : p.assessment.risk === "medium" ? "text-warn" : "text-ok")}>risk {p.assessment.risk}</span>
              </div>
              <p className="mt-1.5 text-[13px] leading-snug text-foreground/85">{p.assessment.why}</p>
            </>
          ) : null}
          {p.recommendation && (
            <p className={cn("text-[12px] leading-snug text-muted-foreground", p.assessment && "mt-2 border-t border-border/60 pt-2")}>
              <span className="font-mono text-[11px] uppercase tracking-wide">governor</span> · {p.recommendation}{p.why ? ` — ${p.why}` : ""}{p.risk ? <span className="block mt-0.5">uncertainty: {p.risk}</span> : null}
            </p>
          )}
        </div>
      )}
      {c.operation && !done && (
        <div className="mx-4 mb-3 font-mono text-[11px] text-muted-foreground">approve → main {c.operation.type === "op" ? `runs op read (Touch ID) for ${c.operation.refs.join(", ")}` : "raises the browser for your sign-in"} → then releases {c.worker}</div>
      )}

      {/* ── the decision, under the last turn ── */}
      {pending ? (
        <div className="fade-in border-t border-border px-4 py-3">
          <label className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{c.followUp?.[pending]?.label}</label>
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={2}
            className="mt-1 w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            <Button size="sm" disabled={busy || (c.followUp?.[pending]?.required && !text.trim())} onClick={() => submit(pending, text)}>{c.options?.find((o) => o.key === pending)?.label ?? "Send"}</Button>
          </div>
        </div>
      ) : waiting ? (
        <footer className="flex items-center justify-between gap-3 border-t border-border bg-muted/40 px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
          <span className="text-destructive">{error}</span>
          <span>buttons return when {c.worker} replies</span>
        </footer>
      ) : (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
          {error && <span className="mr-auto text-[12px] text-destructive">{error}</span>}
          {done && <Badge variant="ok" className="mr-auto"><CircleCheck />answered · {done}</Badge>}
          {!done && opts.map((o) => (
            <Button key={o.key} size="sm" variant={o.key === "reject" ? "destructive" : o.key === "show" ? "ghost" : "outline"} disabled={busy} onClick={() => pick(o.key)} title={o.description}>
              {o.key === "show" && evidence ? "Hide evidence" : o.label}
            </Button>
          ))}
          {!done && primary && <Button size="sm" disabled={busy} onClick={() => pick(primary)} title={c.options?.find((o) => o.key === primary)?.description}>{c.options?.find((o) => o.key === primary)?.label}</Button>}
        </footer>
      )}
    </Card>
  );
}
