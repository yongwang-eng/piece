import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Inbox, Users } from "lucide-react";
import { getState, getCrew, events, ago, clock, money, type State, type Crew, type Detail, type Consult } from "./api.ts";
import { cn } from "@/lib/utils";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionHead, Row, Dot, Chevron, KV, Empty, Disclosure, Tabs, StatusBadge, statusOf, CLASS_TONE } from "./ui.tsx";
import { ConsultCard } from "./ConsultCard.tsx";
import { Topology } from "./Topology.tsx";

// ── routing: history API; the server serves index.html for every path ───────────────────────────────────────────────

type Route = { page: "home" } | { page: "crew"; run: string };
const parse = (): Route => { const m = window.location.pathname.match(/^\/crews\/([^/]+)/); return m ? { page: "crew", run: decodeURIComponent(m[1]) } : { page: "home" }; };
const useRoute = () => {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => { const on = () => setRoute(parse()); window.addEventListener("popstate", on); return () => window.removeEventListener("popstate", on); }, []);
  const go = useCallback((path: string) => { window.history.pushState(null, "", path); setRoute(parse()); window.scrollTo(0, 0); }, []);
  return { route, go };
};

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [now, setNow] = useState(Date.now());
  const { route, go } = useRoute();
  const refresh = useCallback(() => getState().then(setState).catch(() => {}), []);
  useEffect(() => { void refresh(); const stop = events(() => void refresh()); const t = setInterval(() => setNow(Date.now()), 15000); const p = setInterval(refresh, 15000); return () => { stop(); clearInterval(t); clearInterval(p); }; }, [refresh]);
  useEffect(() => { if (state) document.title = `${state.open.length ? `(${state.open.length}) ` : ""}${route.page === "crew" ? `${route.run} · ` : ""}Crew Console`; }, [state, route]);

  if (!state) return <div className="p-10 font-mono text-[12px] text-muted-foreground">connecting…</div>;
  const running = state.crews.filter((c) => c.live).length;
  return (
    <div className="min-h-screen pb-24">
      <header className="toolbar sticky top-0 z-10 border-b border-border">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-6 py-2.5">
          <div className="flex items-center gap-3">
            <a href="/" onClick={(e) => { e.preventDefault(); go("/"); }} className="inline-flex items-center gap-2 font-mono text-[13px] font-semibold tracking-tight">
              <span className="inline-block size-2.5 rounded-[3px] bg-signal" />crew console
            </a>
            {route.page === "crew" && <><span className="text-muted-foreground/50">/</span><span className="font-mono text-[12px] text-muted-foreground">{route.run}</span></>}
          </div>
          <div className="flex items-center gap-2">
            {state.open.length > 0 && (
              <a href="/" onClick={(e) => { e.preventDefault(); go("/"); }}><Badge variant="signal"><Dot tone="signal" live className="size-1.5" />{state.open.length} need{state.open.length === 1 ? "s" : ""} you</Badge></a>
            )}
            <Badge variant="outline"><Dot tone={running ? "info" : "neutral"} className="size-1.5" />{running} running</Badge>
          </div>
        </div>
      </header>
      {route.page === "home" ? <Home state={state} now={now} go={go} refresh={refresh} /> : <CrewPage run={route.run} now={now} open={state.open} refresh={refresh} />}
    </div>
  );
}

// ── home: inbox → Running rows → Completed (folded) → Decisions (folded) ────────────────────────────────────────────
function Home({ state, now, go, refresh }: { state: State; now: number; go: (p: string) => void; refresh: () => void }) {
  const running = state.crews.filter((c) => c.live).slice().sort((a, b) => b.openCount - a.openCount || b.createdAt - a.createdAt);
  const completed = state.crews.filter((c) => !c.live).slice().sort((a, b) => b.createdAt - a.createdAt);
  return (
    <main className="mx-auto max-w-[1600px] space-y-7 px-6 pt-6">
      <section>
        <SectionHead title="Needs you" count={state.open.length} tone={state.open.length ? "signal" : undefined} />
        {state.open.length === 0 ? (
          <Card className="flex items-center gap-3 px-4 py-3 text-[12px] text-muted-foreground"><Inbox className="size-4 text-ok" />Inbox clear — nothing needs you.</Card>
        ) : (
          <div className={cn("grid gap-3", state.open.length > 1 && "2xl:grid-cols-2")}>
            {state.open.map((c) => <ConsultCard key={`${c.run}/${c.id}`} c={c} now={now} onAnswered={refresh} />)}
          </div>
        )}
      </section>

      <section>
        <SectionHead title="Running" count={running.length} right={running.length ? <span className="font-mono text-[11px]">workers · spend</span> : undefined} />
        <Card className="overflow-hidden">
          {running.length === 0 && <Empty>No crew is running.</Empty>}
          {running.map((c) => <CrewRow key={c.id} c={c} now={now} onClick={() => go(`/crews/${c.id}`)} />)}
        </Card>
      </section>

      <Disclosure id="completed" title="Completed" count={completed.length} right={<span className="font-mono text-[11px]">newest first · workers · spend</span>}>
        {completed.length === 0 && <Empty>Nothing has finished yet.</Empty>}
        {completed.map((c) => <CrewRow key={c.id} c={c} now={now} onClick={() => go(`/crews/${c.id}`)} />)}
      </Disclosure>

      <DecisionsDisclosure state={state} go={go} />
    </main>
  );
}

function DecisionsDisclosure({ state, go }: { state: State; go: (p: string) => void }) {
  const [filter, setFilter] = useState<{ run?: string; kind?: string }>({});
  const decisions = state.decisions.filter((d) => (!filter.run || d.run === filter.run) && (!filter.kind || d.kind === filter.kind));
  const kinds = [...new Set(state.decisions.map((d) => d.kind))].sort();
  const sel = "h-7 rounded-md border border-input bg-card px-2 font-mono text-[11px] text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
  return (
    <Disclosure id="decisions" title="Decisions" count={decisions.length} right={
      <div className="flex gap-2">
        <select value={filter.run ?? ""} onChange={(e) => setFilter({ ...filter, run: e.target.value || undefined })} className={sel}><option value="">all crews</option>{state.crews.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.slug}</option>)}</select>
        <select value={filter.kind ?? ""} onChange={(e) => setFilter({ ...filter, kind: e.target.value || undefined })} className={sel}><option value="">all kinds</option>{kinds.map((k) => <option key={k}>{k}</option>)}</select>
      </div>}>
      {decisions.length === 0 ? <Empty>No decisions recorded yet.</Empty> : <DecisionTable rows={decisions} showRun onRun={(r) => go(`/crews/${r}`)} />}
    </Disclosure>
  );
}

function CrewRow({ c, now, onClick }: { c: Crew; now: number; onClick: () => void }) {
  const s = statusOf(c.openCount ? "blocked" : c.status);
  return (
    <Row onClick={onClick}>
      <Dot tone={s.tone} live={c.live} />
      <span className="w-16 shrink-0 font-mono text-[12px] text-muted-foreground">{c.id}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{c.slug}</span>
      {c.owner && <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline" title="tmux window of the main that owns this crew">{c.owner}</span>}
      <span className={cn("shrink-0 font-mono text-[11px]", c.openCount ? "font-medium text-signal" : "text-muted-foreground")}>
        {c.openCount ? `${c.openCount} need${c.openCount === 1 ? "s" : ""} you` : s.label}{c.live ? ` · ${ago(now - c.createdAt)}` : ""}
      </span>
      {c.outcome && <span className="hidden min-w-0 max-w-[40%] truncate text-[12px] text-muted-foreground md:inline" title={c.outcome}>{c.outcome}</span>}
      <span className="flex w-28 shrink-0 items-center justify-end gap-2 font-mono text-[11px] tabular-nums text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Users className="size-3" />{c.workers}</span><span>{money(c.cost)}</span>
      </span>
      <Chevron />
    </Row>
  );
}

// ── decisions: a real table — full width earns the answer column; `compact` (a narrow pane) folds the answer into the expanded row ──
function DecisionTable({ rows, showRun, onRun, compact }: { rows: Consult[]; showRun?: boolean; onRun?: (run: string) => void; compact?: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const who = (d: Consult) => d.answeredBy?.startsWith("human") ? "you" : d.answeredBy?.startsWith("withdrawn") ? "withdrawn" : d.answeredBy ?? "—";
  const th = "py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
  return (
    <table className={cn("w-full text-[13px]", !compact && "table-fixed")}>
      <thead className="text-left">
        <tr className="border-b border-border">
          <th className={cn(th, "w-16 px-4")}>Asked</th>
          {showRun && <th className={cn(th, "w-20")}>Crew</th>}
          <th className={cn(th, compact ? "w-36" : "w-44")}>Worker</th>
          <th className={cn(th, "w-28")}>Kind</th>
          <th className={th}>Question</th>
          {!compact && <th className={cn(th, "w-[28%]")}>Answer</th>}
          <th className={cn(th, compact ? "w-24" : "w-32")}>Choice</th>
          <th className={cn(th, "w-14 pr-4 text-right")}>Wait</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => {
          const open = openId === `${d.run}/${d.id}`;
          return (
            <tr key={`${d.run}/${d.id}`} onClick={() => setOpenId(open ? null : `${d.run}/${d.id}`)} className={cn("cursor-pointer border-t border-border align-top first:border-t-0 hover:bg-accent/50", open && "bg-accent/40")}>
              <td className="px-4 py-2.5 font-mono text-[11px] tabular-nums text-muted-foreground">{clock(d.askedAt)}</td>
              {showRun && <td className="py-2.5"><button type="button" onClick={(e) => { e.stopPropagation(); onRun?.(d.run); }} className="font-mono text-[12px] text-signal hover:underline">{d.run}</button></td>}
              <td className={cn("py-2.5 pr-3 font-mono text-[12px]", compact ? "max-w-36 truncate" : "truncate")} title={d.worker}>{d.worker}{d.followUpOf && <span className="ml-1 text-muted-foreground/70">↳ {d.followUpOf}</span>}</td>
              <td className="py-2.5 pr-2"><Badge variant={CLASS_TONE[d.class] ?? "neutral"}>{d.kind}</Badge></td>
              <td className={cn("py-2.5 pr-3", !open && !compact && "truncate")}>
                {d.question}
                {open && d.intent?.exact && <div className="mt-1 whitespace-pre-wrap font-mono text-[12px] text-muted-foreground">{d.intent.exact}</div>}
                {open && compact && <div className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-2 text-[12px] text-muted-foreground">{d.answer ?? "—"}</div>}
              </td>
              {!compact && <td className={cn("py-2.5 pr-3 text-muted-foreground", !open && "truncate")}>{open ? <span className="whitespace-pre-wrap">{d.answer ?? "—"}</span> : d.answer ?? "—"}</td>}
              <td className={cn("py-2.5 font-mono text-[11px]", who(d) === "you" ? "text-signal" : "text-muted-foreground")}>{d.choice ?? d.state}<span className="text-muted-foreground"> · {who(d)}</span></td>
              <td className="py-2.5 pr-4 text-right font-mono text-[11px] tabular-nums text-muted-foreground/70">{d.latencyMs === null ? "—" : ago(d.latencyMs)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── crew page: three panes — who (roster · files) · what happened (tabbed) · what needs deciding ──────────────────
type Tab = "timeline" | "consults" | "topology";
const TABS: Tab[] = ["timeline", "consults", "topology"];
const tabFromHash = (): Tab => { const h = window.location.hash.slice(1) as Tab; return TABS.includes(h) ? h : "timeline"; };

const ICON_TONE: Record<string, string> = { "◆": "text-signal", "◇": "text-ok", "✓": "text-ok", "✕": "text-destructive", "⚠": "text-destructive", "↻": "text-warn" };

function CrewPage({ run, now, open, refresh }: { run: string; now: number; open: Consult[]; refresh: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const setTab = (t: Tab) => { setTabState(t); window.history.replaceState(null, "", `#${t}`); };
  useEffect(() => { const load = () => getCrew(run).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(String(e.message))); load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [run, open.length]);
  if (err) return <main className="p-10 font-mono text-[12px] text-muted-foreground">{run}: {err}</main>;
  if (!d) return <main className="p-10 font-mono text-[12px] text-muted-foreground">loading…</main>;
  const mine = open.filter((c) => c.run === run);
  const status = d.live ? (mine.length ? "blocked" : d.liveMembers.every((n) => n === "main") ? "idle" : "working") : d.status;
  const vault = d.artifacts?.dir.replace(/^.*obsidian_notes\//, "");
  const decided = d.consults.filter((c) => c.state !== "open").slice().sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0));
  const messages = d.topology.edges.reduce((n, e) => n + e.count, 0);

  return (
    <main className="mx-auto max-w-[1600px] px-6 pt-6">
      {/* ── header ── */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <StatusBadge status={status} live={d.live} />
            <span>started {ago(now - d.createdAt)} ago</span>
            {d.live && <span>· {d.liveMembers.length} on the room</span>}
            <span>· {messages} messages</span>
          </div>
          <h1 className="mt-1.5 text-[24px] font-semibold tracking-tight">{d.slug}{d.owner && <span className="ml-3 font-mono text-[13px] font-normal text-muted-foreground">{d.owner}</span>}</h1>
          {d.goal !== d.slug && <p className="mt-1 max-w-4xl text-[13px] text-muted-foreground">{d.goal}</p>}
          {d.closedAt && <p className="mt-2 max-w-4xl border-l-[3px] border-ok pl-3 text-[13px]"><span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">closed {clock(d.closedAt)}</span> — {d.outcome}</p>}
        </div>
        <div className="flex items-center gap-6">
          <Stat label="spend" value={money(d.usage?.totals.estimatedCost ?? null)} />
          <Stat label="calls" value={String(d.usage?.totals.calls ?? 0)} />
          <Stat label="tokens" value={d.usage?.totals.totalTokens ? `${(d.usage.totals.totalTokens / 1e6).toFixed(1)}M` : "—"} />
          {vault && <Button variant="outline" size="sm" onClick={() => { window.location.href = `obsidian://open?vault=obsidian_notes&file=${encodeURIComponent(vault)}`; }}>artifacts<ExternalLink /></Button>}
        </div>
      </div>

      {/* ── three panes ── */}
      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_400px]">
        {/* left — who */}
        <aside className="space-y-4">
          <Card className="overflow-hidden">
            <CardHeader><CardTitle>Roster</CardTitle><span className="font-mono text-[11px] tabular-nums text-muted-foreground">{d.roster.length}</span></CardHeader>
            {d.roster.map((m) => {
              const o = mine.find((c) => c.worker === m.name);
              const present = d.liveMembers.includes(m.name);
              return (
                <Row key={m.name} className="items-start">
                  <Dot tone={o ? "signal" : present ? "info" : "neutral"} live={present} className="mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 break-words font-mono text-[12px] font-semibold leading-tight">{m.name}</span>
                      <span className={cn("shrink-0 font-mono text-[10px]", o ? "text-signal" : "text-muted-foreground")}>{o ? `needs you · ${o.class}` : present ? "present" : m.presence === "gone" ? "left" : m.presence}</span>
                    </div>
                    <div className="truncate text-[12px] text-muted-foreground">{m.role !== m.name ? m.role : m.profile ?? ""}{m.model ? <span className="font-mono text-[10px]"> · {m.model.split("/").pop()}</span> : null}</div>
                    {m.responsibility && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground/80" title={m.responsibility}>{m.responsibility}</div>}
                  </div>
                </Row>
              );
            })}
          </Card>
          <Card className="overflow-hidden">
            <CardHeader><CardTitle>Files</CardTitle></CardHeader>
            <div className="px-4 py-3"><KV keyWidth="64px" rows={[["artifacts", d.artifacts ? <span className="break-all font-mono text-[11px]">{d.artifacts.dir}</span> : "—"], ["children", d.children.length ? <span className="font-mono text-[11px]">{d.children.join(" · ")}</span> : "—"]]} /></div>
          </Card>
        </aside>

        {/* center — what happened */}
        <section className="min-w-0">
          <Card className="overflow-hidden">
            <Tabs<Tab> active={tab} onChange={setTab} tabs={[{ key: "timeline", label: "Room timeline", count: d.timeline.length }, { key: "consults", label: "Consults", count: d.consults.length }, { key: "topology", label: "Topology", count: messages }]} />
            {tab === "timeline" && (
              <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
                {d.timeline.length === 0 && <Empty>nothing recorded</Empty>}
                <ol>{d.timeline.slice().reverse().map((t, i) => (
                  <li key={i} className="flex gap-3 border-t border-border px-4 py-2 text-[13px] first:border-t-0">
                    <span className="w-11 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70 pt-0.5">{clock(t.at)}</span>
                    <span className={cn("w-4 shrink-0 text-center", ICON_TONE[t.icon] ?? "text-muted-foreground/60")}>{t.icon}</span>
                    <span className="min-w-0 flex-1 break-words">{t.text}{t.consult && <button type="button" onClick={() => setTab("consults")} className="ml-2 font-mono text-[10px] text-muted-foreground hover:text-signal">{t.consult}</button>}</span>
                  </li>
                ))}</ol>
                <div className="border-t border-border px-4 py-2 font-mono text-[10px] text-muted-foreground/70">newest first · lifecycle events + what members said (bodies cut at 200 chars; full text in room.jsonl)</div>
              </div>
            )}
            {tab === "consults" && (d.consults.length === 0 ? <Empty>none asked</Empty> : <DecisionTable rows={d.consults} compact />)}
            {tab === "topology" && <div className="p-3"><Topology nodes={d.topology.nodes} edges={d.topology.edges} live={d.liveMembers} blocked={mine.map((c) => c.worker)} /></div>}
          </Card>
        </section>

        {/* right — what needs deciding */}
        <aside className="space-y-4">
          <section>
            <SectionHead title="Needs you" count={mine.length} tone={mine.length ? "signal" : undefined} />
            {mine.length === 0 ? (
              <Card className="flex items-center gap-3 px-4 py-3 text-[12px] text-muted-foreground"><Inbox className="size-4 text-ok" />Nothing from this crew.</Card>
            ) : (
              <div className="space-y-3">{mine.map((c) => <ConsultCard key={c.id} c={c} now={now} onAnswered={refresh} />)}</div>
            )}
          </section>
          <section>
            <SectionHead title="Decided" count={decided.length} right={decided.length ? <button type="button" onClick={() => setTab("consults")} className="font-mono text-[11px] hover:text-signal">all →</button> : undefined} />
            <Card className="overflow-hidden">
              {decided.length === 0 && <Empty>no decisions yet</Empty>}
              {decided.slice(0, 6).map((c) => (
                <Row key={c.id} onClick={() => setTab("consults")} className="items-start py-2">
                  <span className="w-11 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70 pt-0.5">{c.answeredAt ? clock(c.answeredAt) : "—"}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2"><span className="truncate font-mono text-[11px]">{c.worker}</span><Badge variant={CLASS_TONE[c.class] ?? "neutral"}>{c.kind}</Badge></div>
                    <div className="mt-0.5 truncate text-[12px]">{c.question}</div>
                    <div className={cn("mt-0.5 font-mono text-[10px]", c.answeredBy?.startsWith("human") ? "text-signal" : "text-muted-foreground")}>{c.choice ?? c.state} · {c.answeredBy?.startsWith("human") ? "you" : c.answeredBy ?? "—"}{c.latencyMs !== null && <span className="text-muted-foreground"> · {ago(c.latencyMs)}</span>}</div>
                  </div>
                </Row>
              ))}
            </Card>
          </section>
        </aside>
      </div>
    </main>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div><div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div><div className="font-mono text-[18px] font-semibold tabular-nums">{value}</div></div>
);
