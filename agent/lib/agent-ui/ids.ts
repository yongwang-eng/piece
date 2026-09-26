// Stable numeric worker IDs, shared by every worker backend (in-process fleet children, tmux crew
// workers). One id per NEW worker object, monotonic, never derived from row position, never renumbered
// when rows fade. Reset only on a clear, which also bumps a generation so a callback still holding a
// pre-clear object can be told apart from the worker now wearing that name.

/** The only shape this module needs: anything with a name that can carry a numeric id. */
export interface Identified {
  id?: number;
  name: string;
}

export class WorkerIds {
  private next = 1;
  generation = 0;
  private readonly gen = new WeakMap<Identified, number>();

  /** Stamp a freshly created worker. Reuse of a persistent session keeps the same object, hence the same id. */
  assign<A extends Identified>(agent: A): A {
    agent.id = this.next++;
    this.gen.set(agent, this.generation);
    return agent;
  }

  /** A clear: numbering restarts; everything stamped before is stale. */
  reset(): void {
    this.next = 1;
    this.generation++;
  }

  /** Continue above ids that already exist — a backend whose workers outlive this process (a tmux
   *  pane survives /reload) re-adopts them and must not hand the same #N to a new worker. */
  seed(highestExistingId: number): void {
    if (Number.isFinite(highestExistingId) && highestExistingId >= this.next) this.next = Math.floor(highestExistingId) + 1;
  }

  current(agent: Identified): boolean {
    return this.gen.get(agent) === this.generation;
  }
}

/** `#N` or a name → the canonical worker name, or undefined when nothing matches. */
export function resolveChild(agents: readonly Identified[], ref: string): string | undefined {
  const m = /^#(\d+)$/.exec(ref.trim());
  if (m) return agents.find((a) => a.id === Number(m[1]))?.name;
  return agents.find((a) => a.name === ref)?.name;
}
