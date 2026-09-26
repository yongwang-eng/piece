import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { hostname, homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface ProfileSpec {
  name: string;
  identities: string[];
  hosts: string[];
  pool?: boolean;
  description: string;
}

const registry = JSON.parse(readFileSync(join(homedir(), ".pi/agent/config/browser_profiles.json"), "utf8"));
export const PROFILES: ProfileSpec[] = registry.profiles;
export const SCRATCH_POOL_SIZE: number = registry.scratchPoolSize;
export const BROWSER_PROFILES_ROOT: string = registry.root;

export function inferProfile(text: string, needs?: string[], profiles: ProfileSpec[] = PROFILES): ProfileSpec {
  if (needs?.length) {
    const matches = profiles.filter((p) => needs.every((n) => p.identities.includes(n) || p.name === n));
    if (matches.length === 1) return matches[0]!;
    throw new Error(matches.length ? `Ambiguous browser identity: ${needs.join(", ")}; choose a profile explicitly.` : `Unknown browser identity: ${needs.join(", ")}`);
  }
  const hosts = (text.match(/https?:\/\/[^\s"'`)]+/g) ?? []).map((u) => new URL(u).hostname);
  const matches = profiles.filter((p) => !p.pool && hosts.some((h) => p.hosts.some((suffix) => h === suffix || h.endsWith(`.${suffix}`))));
  if (matches.length > 1) throw new Error("Ambiguous browser task; choose one identity profile explicitly.");
  return matches[0] ?? profiles.find((p) => p.pool)!;
}

export interface Lease { profile: string; dir: string; lockPath: string; token?: string }
interface LockInfo { pid: number; run: string; child: string; at: string; token?: string }

export function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

export class ProfilePool {
  readonly root: string;
  readonly profiles: ProfileSpec[];
  constructor(root: string, profiles: ProfileSpec[] = PROFILES) { this.root = root; this.profiles = profiles; mkdirSync(root, { recursive: true, mode: 0o700 }); }
  dirFor(name: string) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error("Invalid browser profile name");
    return join(this.root, name);
  }
  private lockPath(name: string) { return join(this.dirFor(name), "fleet.lock"); }

  private exclusive<T>(fn: () => T): T {
    const mutex = join(this.root, ".registry.lock");
    // Do not steal a mutex: a crashed writer may have left an incomplete lease transition.
    try { writeFileSync(mutex, String(process.pid), { flag: "wx", mode: 0o600 }); }
    catch { throw new Error(`Browser registry is busy (${mutex}); retry, or inspect a stale writer before clearing it.`); }
    try { return fn(); } finally { unlinkSync(mutex); }
  }

  readLock(name: string): LockInfo | undefined {
    const p = this.lockPath(name);
    if (!existsSync(p)) return undefined;
    const lock = JSON.parse(readFileSync(p, "utf8"));
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.run !== "string" || typeof lock.child !== "string") throw new Error(`Invalid browser lease: ${p}`);
    return lock;
  }

  holder(name: string): LockInfo | undefined {
    const l = this.readLock(name);
    return l && isAlive(l.pid) ? l : undefined;
  }

  browserAlive(name: string): boolean {
    let target: string;
    try { target = readlinkSync(join(this.dirFor(name), "SingletonLock")); }
    catch (e: any) { if (e.code === "ENOENT") return false; throw e; }
    const m = /^(.*)-(\d+)$/.exec(target);
    if (!m || m[1] !== hostname()) throw new Error(`Cannot verify Chrome owner for ${name}; close it manually before handover.`);
    return isAlive(Number(m[2]));
  }

  lease(spec: ProfileSpec, run: string, child: string, pid = process.pid): Lease {
    const registered = this.profiles.find((p) => p.name === spec.name);
    if (!registered) throw new Error(`Unknown browser profile: ${spec.name}`);
    spec = registered;
    return this.exclusive(() => {
      const candidates = spec.pool ? Array.from({ length: SCRATCH_POOL_SIZE }, (_, i) => `${spec.name}-${i + 1}`) : [spec.name];
      for (const name of candidates) {
        const h = this.holder(name);
        if (h && !(h.pid === pid && h.run === run && h.child === child)) continue;
        if (!h && this.browserAlive(name)) continue;
        mkdirSync(this.dirFor(name), { recursive: true, mode: 0o700 });
        const token = h?.token ?? randomUUID();
        this.writeLock(name, { pid, run, child, at: new Date().toISOString(), token });
        return { profile: name, dir: this.dirFor(name), lockPath: this.lockPath(name), token };
      }
      const h = this.holder(candidates[0]!);
      throw new Error(`Browser profile "${spec.name}" is in use${h ? ` by ${h.child}@${h.run} (pid ${h.pid})` : " by a live Chrome"}. Close its owner before handover; do not take over the profile.`);
    });
  }

  private writeLock(name: string, lock: LockInfo) {
    const path = this.lockPath(name);
    writeFileSync(path + ".tmp", JSON.stringify(lock), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }

  adopt(lease: Lease, pid: number) {
    this.exclusive(() => {
      const l = this.readLock(lease.profile);
      if (!l || !lease.token || l.token !== lease.token || !isAlive(pid)) throw new Error("Browser lease changed or daemon exited during launch");
      this.writeLock(lease.profile, { ...l, pid });
    });
  }

  release(lease: Lease, pid = process.pid) {
    this.exclusive(() => {
      const l = this.readLock(lease.profile);
      if (!l || l.pid !== pid || l.token !== lease.token) return;
      if (this.browserAlive(lease.profile)) throw new Error("Browser is still running; retain its lease until it closes.");
      unlinkSync(this.lockPath(lease.profile));
    });
  }

  status(): Array<{ name: string; exists: boolean; holder?: LockInfo; spec?: ProfileSpec }> {
    const names = new Set<string>(this.profiles.filter((p) => !p.pool).map((p) => p.name));
    for (let i = 1; i <= SCRATCH_POOL_SIZE; i++) names.add(`scratch-${i}`);
    for (const d of readdirSync(this.root, { withFileTypes: true })) if (d.isDirectory()) names.add(d.name);
    return [...names].sort().map((name) => ({ name, exists: existsSync(this.dirFor(name)), holder: this.holder(name), spec: PROFILES.find((p) => p.name === name || (p.pool && name.startsWith(`${p.name}-`))) }));
  }
}

export function playwrightConfig(profileDir: string, outputDir: string) {
  return {
    settings: { directTools: false, autoAuth: false },
    mcpServers: {
      playwright: {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--browser", "chromium", "--user-data-dir", profileDir, "--output-dir", outputDir],
        lifecycle: "lazy",
      },
    },
  };
}
