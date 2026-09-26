import { useState } from "react";
import type { TopoNode, TopoEdge } from "./api.ts";

/** main at the centre, everyone else on a ring; edge width = log(messages); colour = presence / needs-you. */
export function Topology({ nodes, edges, live, blocked, onPick }: { nodes: TopoNode[]; edges: TopoEdge[]; live: string[]; blocked: string[]; onPick?: (name: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const W = 760, H = 460, cx = W / 2, cy = H / 2;
  const ring = nodes.filter((n) => n.kind !== "main");
  const main = nodes.find((n) => n.kind === "main");
  const R = Math.min(cx, cy) - 70;
  const pos = new Map<string, { x: number; y: number }>();
  if (main) pos.set(main.name, { x: cx, y: cy });
  ring.forEach((n, i) => { const a = -Math.PI / 2 + (i / Math.max(ring.length, 1)) * 2 * Math.PI; pos.set(n.name, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }); });
  const tone = (n: TopoNode) => blocked.includes(n.name) ? "var(--color-signal)" : n.kind === "human" ? "var(--color-ok)" : n.kind === "governor" ? "var(--color-neutral)" : live.includes(n.name) ? "var(--color-info)" : "var(--color-neutral)";
  const max = Math.max(1, ...edges.map((e) => e.count));
  const width = (c: number) => 1 + 3 * Math.log1p(c) / Math.log1p(max);
  const lit = (e: TopoEdge) => !hover || e.from === hover || e.to === hover;
  const short = (s: string, n = 30) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" style={{ maxHeight: 480 }}>
        <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="var(--color-neutral)" /></marker></defs>
        {edges.map((e) => {
          const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) return null;
          const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
          // offset the two directions of a pair so they do not overlap; trim to the node radius
          const nx = -dy / len * 5, ny = dx / len * 5, r = 26;
          const x1 = a.x + dx / len * r + nx, y1 = a.y + dy / len * r + ny, x2 = b.x - dx / len * r + nx, y2 = b.y - dy / len * r + ny;
          return (
            <g key={`${e.from}→${e.to}`} opacity={lit(e) ? 1 : 0.15} style={{ transition: "opacity 200ms ease-out" }}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-neutral)" strokeOpacity="0.55" strokeWidth={width(e.count)} markerEnd="url(#arrow)" />
              {hover && lit(e) && <text x={(x1 + x2) / 2 + nx * 2} y={(y1 + y2) / 2 + ny * 2} fontSize="10" fill="var(--color-muted-foreground)" textAnchor="middle">{e.count}</text>}
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = pos.get(n.name)!; const isMain = n.kind === "main"; const r = isMain ? 30 : 22;
          return (
            <g key={n.name} transform={`translate(${p.x},${p.y})`} onMouseEnter={() => setHover(n.name)} onMouseLeave={() => setHover(null)} onClick={() => onPick?.(n.name)} style={{ cursor: onPick ? "pointer" : "default" }}>
              {live.includes(n.name) && <circle r={r + 5} fill="none" stroke={tone(n)} strokeOpacity="0.25" strokeWidth="2" className="live-dot" />}
              <circle r={r} fill="var(--color-card)" stroke={tone(n)} strokeWidth={isMain ? 3 : 2} />
              <text y="4" fontSize={isMain ? 12 : 10} fontWeight={600} textAnchor="middle" fill="var(--color-foreground)">{n.kind === "worker" ? (n.sent + n.received || "") : n.kind}</text>
              <text y={r + 14} fontSize="11" textAnchor="middle" fill="var(--color-foreground)">{short(n.name)}</text>
              {n.kind === "worker" && n.role !== n.name && <text y={r + 26} fontSize="9.5" textAnchor="middle" fill="var(--color-muted-foreground)">{short(n.role.replace(/ — .*$/, ""), 34)}</text>}
              {n.consults > 0 && <g transform={`translate(${r - 4},${-r + 4})`}><circle r="8" fill="var(--color-signal)" /><text y="3" fontSize="9" fontWeight={700} textAnchor="middle" fill="white">{n.consults}</text></g>}
            </g>
          );
        })}
      </svg>
      {hover && (() => { const n = nodes.find((x) => x.name === hover)!; const out = edges.filter((e) => e.from === hover), inn = edges.filter((e) => e.to === hover); return (
        <div className="fade-in absolute left-3 top-3 max-w-xs rounded-md border border-border bg-card px-3 py-2 text-[12px] shadow-sm">
          <div className="font-mono font-semibold">{n.name}</div><div className="text-muted-foreground">{n.role}</div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">sent {n.sent} · received {n.received}{n.consults ? ` · ${n.consults} consult${n.consults > 1 ? "s" : ""}` : ""}</div>
          {out.length > 0 && <div className="mt-1">→ {out.map((e) => `${e.to} ${e.count}`).join(" · ")}</div>}
          {inn.length > 0 && <div>← {inn.map((e) => `${e.from} ${e.count}`).join(" · ")}</div>}
          {n.talksTo && <div className="mt-1 text-muted-foreground/70">may address: {n.talksTo.join(", ")}</div>}
        </div>
      ); })()}
      <div className="flex flex-wrap gap-x-4 gap-y-1 whitespace-nowrap px-1 pb-1 font-mono text-[11px] text-muted-foreground"><span className="text-info">● present</span><span className="text-signal">● needs you</span><span>● left / governor</span><span>badge = consults asked</span><span>edge width = messages · hover a node</span></div>
    </div>
  );
}
