// secret-lease — hold a 1Password secret in THIS pi process's memory (process.env) after one Touch ID.
// The registry is the list: an unlisted name is refused before any read. Values never appear in output.
export type Entry = { item: string; vault: string; ttl_hours?: number; fields: Record<string, string> };
export type Registry = Record<string, Entry>;
export type ReadItem = (vault: string, item: string) => Promise<Record<string, string>>;

const DEFAULT_TTL_H = 12;

/** The ledger a /reload must not lose: the values stay in process.env across a reload, so the expiries must too, or a
 *  live lease turns into an unaudited env var and the next unlock is a needless Touch ID. Process-wide, like `problems`. */
export const processLedger = (): Map<string, number> => {
  const g = globalThis as Record<symbol, unknown>;
  const k = Symbol.for("pi.agent.secret-lease.until");
  return (g[k] as Map<string, number> | undefined) ?? ((g[k] = new Map<string, number>()) as Map<string, number>);
};

export class Lease {
  private until: Map<string, number>;
  private registry: () => Registry;
  private read: ReadItem;
  private env: Record<string, string | undefined>;
  private now: () => number;
  private onHit: (name: string) => void;
  constructor(registry: Registry | (() => Registry), read: ReadItem, env: Record<string, string | undefined> = process.env, now: () => number = Date.now, onHit: (name: string) => void = () => {}, ledger: Map<string, number> = new Map()) {
    this.registry = typeof registry === "function" ? registry : () => registry; this.read = read; this.env = env; this.now = now; this.onHit = onHit; this.until = ledger;
  }

  async unlock(name: string): Promise<string> {
    const e = this.registry()[name];
    if (!e) throw new Error(`"${name}" is not in config/secrets.json — add it there first (a diff, not a judgement)`);
    this.sweep();
    if (!this.until.has(name)) {
      const values = await this.read(e.vault, e.item);
      const missing = Object.keys(e.fields).filter((f) => !values[f]);
      if (missing.length) throw new Error(`${e.vault}/${e.item} is missing field(s): ${missing.join(", ")}`);
      for (const [field, envVar] of Object.entries(e.fields)) this.env[envVar] = values[field];
      this.until.set(name, this.now() + (e.ttl_hours ?? DEFAULT_TTL_H) * 3600_000);
    } else this.onHit(name);
    const left = Math.round((this.until.get(name)! - this.now()) / 3600_000);
    return `${name}: unlocked → ${Object.values(e.fields).join(", ")} (in memory, expires in ~${left}h)`;
  }

  /** Leased and unexpired — an unlock of this name will NOT reach 1Password. */
  isWarm(name: string): boolean { this.sweep(); return this.until.has(name); }

  lock(name: string): void {
    const e = this.registry()[name];
    if (!e) return;
    for (const envVar of Object.values(e.fields)) delete this.env[envVar];
    this.until.delete(name);
  }

  status(): string[] {
    this.sweep();
    return [...this.until.keys()].map((n) => `${n} → ${Object.values(this.registry()[n].fields).join(", ")}`);
  }

  /** env var → secret name, for every live lease. */
  leasedVars(): Map<string, string> {
    this.sweep();
    const out = new Map<string, string>();
    for (const n of this.until.keys()) for (const v of Object.values(this.registry()[n].fields)) out.set(v, n);
    return out;
  }

  /** The leased value behind an `op://vault/item/field` ref, or undefined when that secret is not leased here. */
  valueFor(ref: string): { name: string; value: string } | undefined {
    const m = /^op:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(ref);
    if (!m) return undefined;
    this.sweep();
    for (const [name, e] of Object.entries(this.registry())) {
      if (e.vault !== m[1] || e.item !== m[2] || !this.until.has(name)) continue;
      const envVar = e.fields[m[3]];
      const value = envVar ? this.env[envVar] : undefined;
      return value === undefined ? undefined : { name, value };
    }
    return undefined;
  }

  private sweep(): void {
    const t = this.now();
    for (const [n, exp] of this.until) if (exp <= t) this.lock(n);
  }
}
