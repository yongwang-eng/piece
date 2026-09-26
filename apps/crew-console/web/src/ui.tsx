import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Badge, type BadgeVariant } from "@/components/ui/badge";

/** The five semantic tones every status in the console maps onto. `signal` (terracotta) means exactly one thing: needs you. */
export type Tone = "signal" | "ok" | "warn" | "info" | "neutral" | "destructive";

export const STATUS: Record<string, { tone: Tone; label: string }> = {
  blocked: { tone: "signal", label: "needs you" },
  working: { tone: "info", label: "working" },
  idle: { tone: "neutral", label: "idle · main only" },
  merged: { tone: "ok", label: "merged" },
  reported: { tone: "ok", label: "reported" },
  aborted: { tone: "destructive", label: "aborted" },
  closed: { tone: "ok", label: "closed" },
  ended: { tone: "neutral", label: "ended" },
};
export const statusOf = (s: string) => STATUS[s] ?? STATUS.ended;

/** consult class → tone: auth is a sign-in (info), money is red, every other human class is the signal. */
export const CLASS_TONE: Record<string, BadgeVariant> = { auth: "info", money: "destructive", irreversible: "signal", notify: "signal", policy: "signal", scope: "signal" };

const DOT: Record<Tone, string> = { signal: "bg-signal", ok: "bg-ok", warn: "bg-warn", info: "bg-info", neutral: "bg-neutral/60", destructive: "bg-destructive" };
export const Dot = ({ tone, live, className }: { tone: Tone; live?: boolean; className?: string }) => (
  <span className={cn("inline-block size-2 shrink-0 rounded-full", DOT[tone], live && "live-dot", className)} />
);

export const StatusBadge = ({ status, live, children }: { status: string; live?: boolean; children?: ReactNode }) => {
  const s = statusOf(status);
  return <Badge variant={s.tone}><Dot tone={s.tone} live={live} className="size-1.5" />{children ?? s.label}</Badge>;
};

/** Section heading over a card: mono uppercase label, count, optional right slot. */
export const SectionHead = ({ title, count, right, tone, className }: { title: ReactNode; count?: number; right?: ReactNode; tone?: Tone; className?: string }) => (
  <div className={cn("flex items-baseline justify-between gap-3 px-1 pb-2", className)}>
    <h2 className={cn("font-mono text-[11px] font-semibold uppercase tracking-wider", tone === "signal" ? "text-signal" : "text-muted-foreground")}>
      {title}{count !== undefined && <span className="ml-2 font-normal tabular-nums text-muted-foreground/70">{count}</span>}
    </h2>
    {right && <div className="text-[12px] text-muted-foreground">{right}</div>}
  </div>
);

/** A list row inside a Card; rows are separated by hairlines. */
export const Row = ({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) => (
  <div onClick={onClick} className={cn("flex min-h-11 items-center gap-3 px-4 py-2.5 border-t border-border first:border-t-0", onClick && "cursor-pointer hover:bg-accent/60", className)}>{children}</div>
);

export const Chevron = () => <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />;

export const Empty = ({ children }: { children: ReactNode }) => <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">{children}</div>;

/** key/value lines, keys dim and aligned — the Intent block, the packet */
export const KV = ({ rows, keyWidth = "92px" }: { rows: Array<[string, ReactNode | null | undefined]>; keyWidth?: string }) => (
  <dl className="grid gap-x-3 gap-y-1 text-[13px]" style={{ gridTemplateColumns: `${keyWidth} minmax(0,1fr)` }}>
    {rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
      <div key={k} className="contents"><dt className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground pt-0.5">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>
    ))}
  </dl>
);

// ── disclosure: collapsed by default, remembers its open state per id in localStorage ────────────────────────────────
const LS = (id: string) => `crew-console:disclosure:${id}`;
export function useRemembered(id: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => { try { const v = localStorage.getItem(LS(id)); return v === null ? fallback : v === "1"; } catch { return fallback; } });
  useEffect(() => { try { localStorage.setItem(LS(id), open ? "1" : "0"); } catch { /* private mode */ } }, [id, open]);
  return [open, setOpen];
}

export function Disclosure({ id, title, count, right, children, defaultOpen = false }: { id: string; title: ReactNode; count?: number; right?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useRemembered(id, defaultOpen);
  return (
    <section>
      <div className="flex items-center justify-between gap-3 px-1 pb-2">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="group inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          {title}{count !== undefined && <span className="font-normal tabular-nums text-muted-foreground/70">{count}</span>}
        </button>
        {right && open && <div className="text-[12px] text-muted-foreground">{right}</div>}
      </div>
      {open && <Card className="fade-in overflow-hidden">{children}</Card>}
    </section>
  );
}

// ── tabs: a mono tab strip; the active tab carries a terracotta underline ─────────────────────────────────────────────
export function Tabs<K extends string>({ tabs, active, onChange }: { tabs: Array<{ key: K; label: string; count?: number }>; active: K; onChange: (k: K) => void }) {
  return (
    <div role="tablist" className="flex items-end gap-1 border-b border-border px-2">
      {tabs.map((t) => (
        <button key={t.key} role="tab" type="button" aria-selected={active === t.key} onClick={() => onChange(t.key)}
          className={cn("-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider transition-colors",
            active === t.key ? "border-signal text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {t.label}{t.count !== undefined && <span className="font-normal tabular-nums text-muted-foreground/70">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
