// governor lifecycle primitives — one instance, created once per burst of callers, reset on dispose/clear/reload.
// Pure; no pi imports so it runs under node --test. Shared by every worker backend (fleet, crew).

/** Thrown to callers whose governor was cleared while still spinning up. Not a failure: the next call recreates it. */
export class GovernorReset extends Error {
  constructor() { super("governor was reset while starting"); this.name = "GovernorReset"; }
}

export class SingleFlight<T extends { dispose?: () => void }> {
  private inflight: Promise<T> | undefined;
  private generation = 0;
  current: T | undefined;
  /** The last creation attempt's error, until the next attempt or reset. A GovernorReset is not a failure. */
  failure: Error | undefined;
  private readonly factory: () => Promise<T>;

  constructor(factory: () => Promise<T>) { this.factory = factory; }

  /** A creation is in flight and nothing is ready yet. */
  get starting(): boolean { return this.current === undefined && this.inflight !== undefined; }

  get(): Promise<T> {
    if (this.current) return Promise.resolve(this.current);
    if (this.inflight) return this.inflight;
    const gen = this.generation;
    this.failure = undefined;
    const p = this.factory().then(
      (t) => {
        if (gen !== this.generation) { t.dispose?.(); throw new GovernorReset(); }
        this.current = t; this.inflight = undefined; return t;
      },
      (err) => { if (gen === this.generation) { this.inflight = undefined; this.failure = err instanceof Error ? err : new Error(String(err)); } throw err; },
    );
    this.inflight = p;
    return p;
  }

  reset() {
    this.generation++;
    this.current?.dispose?.();
    this.current = undefined;
    this.inflight = undefined;
    this.failure = undefined;
  }
}

export type GovernorState = "absent" | "starting" | "ready" | "consulting" | "failed";

/** What the board shows for the governor, read off the lifecycle itself (no polling, no model call).
 *  `turnsInFlight` counts governor turns started and not yet settled; it only means "consulting" while a
 *  governor is actually there — a turn left over from a disposed governor is not. */
export function governorState(sf: SingleFlight<any>, turnsInFlight: number): GovernorState {
  if (sf.current) return turnsInFlight > 0 ? "consulting" : "ready";
  if (sf.starting) return "starting";
  return sf.failure ? "failed" : "absent";
}

/** In-flight turns per governor instance. Keyed by the session object, so a turn still settling on a
 *  governor that /fleet clear disposed can never make its replacement read "consulting". */
export class TurnTally {
  private readonly n = new WeakMap<object, number>();
  bump(governor: object, delta: number): void { this.n.set(governor, (this.n.get(governor) ?? 0) + delta); }
  count(governor: object | undefined): number { return governor ? this.n.get(governor) ?? 0 : 0; }
}

export interface TurnSession {
  subscribe(fn: (ev: any) => void): () => void;
  prompt(text: string): Promise<unknown>;
}

export const textOf = (message: any): string =>
  (message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text as string).join(" ").replace(/\s+/g, " ").trim();

/** Wait for prompt settlement: agent_end fires before the SDK is idle, so releasing the queue there
 *  makes an immediate packet prompt fail as "already processing". This also waits through retries and
 *  settles when dispose clears listeners before aborting (no final event reaches us). */
export function boundedTurn(g: TurnSession, prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    let last = "";
    let done = false;
    const unsub = g.subscribe((ev: any) => {
      if (ev.type === "message_end" && ev.message?.role === "assistant") last = textOf(ev.message) || last;
    });
    const fin = () => { if (done) return; done = true; unsub(); resolve(last); };
    g.prompt(prompt).then(fin, fin);
  });
}


/** Serialize jobs; reset() detaches from whatever is in flight so a wedged job can never block the next one. */
export class TurnQueue {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => {});
    return next;
  }
  reset() { this.chain = Promise.resolve(); }
}

