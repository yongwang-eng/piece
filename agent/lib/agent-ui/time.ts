// Elapsed-time formatting shared by every worker board: 45s · 3m07 · 2h05 · 2d (a paused Devin row lives for days).
// One implementation so a fleet row and a crew row never disagree about how long something has run.

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${String(m % 60).padStart(2, "0")}` : `${Math.floor(h / 24)}d`;
}
