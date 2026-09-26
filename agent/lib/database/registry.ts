import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { openCrewStore, type Owner } from './store.ts';

type Binding = {
  sessionId: string;
  store: ReturnType<typeof openCrewStore>;
  owner: Owner;
};

export function installCrewRegistry(pi: Pick<ExtensionAPI, 'on'>, path: string): () => Binding {
  let binding: Binding | undefined;
  const close = () => {
    const old = binding;
    binding = undefined;
    if (old) {
      try { old.store.releaseMain(old.owner); }
      finally { old.store.close(); }
    }
  };
  pi.on('session_start', (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (binding?.sessionId === sessionId) return;
    close();
    const store = openCrewStore(path);
    try {
      const main = store.ensureMain(sessionId);
      const owner = store.claimMain(main.id, randomUUID());
      binding = { sessionId, store, owner };
    } catch (error) { store.close(); throw error; }
  });
  pi.on('session_shutdown', close);
  return () => {
    if (!binding) throw new Error('crew registry not initialized');
    return binding;
  };
}

/**
 * The PROCESS-wide binding: one store handle, one owner lease, shared by crew, the usage
 * recorder, and any future consumer.
 *
 * Three facts about pi force this shape:
 *   1. every extension is loaded through its own jiti instance with `moduleCache: false`
 *      (core/extensions/loader.js:409-427) — module-level state is per-EXTENSION, not per-process,
 *      so two extensions would mint two instance IDs and the second claim would be rejected
 *      ("main already owned by another instance").
 *   2. `/reload` re-instantiates extensions in the SAME process and rebinds them to a NEW event
 *      bus — so a cached accessor from before the reload is subscribed to a dead bus and can
 *      never rebind. The slot therefore holds the binding, never the accessor.
 *   3. session_shutdown/session_start ordering across a reload is not guaranteed relative to the
 *      new instances' subscriptions, so binding is ALSO lazy: any consumer may rebind on demand.
 *
 * One process = one instance ID; claimMain is idempotent for the same ID, so every extension
 * instance may claim freely and the single-owner invariant still holds.
 */
const KEY = Symbol.for("pi.agent.registry");
type Slot = { instanceId: string; sessionId?: string; binding?: Binding };

const slot = (): Slot => {
  const g = globalThis as Record<symbol, unknown>;
  return (g[KEY] as Slot | undefined) ?? ((g[KEY] = { instanceId: randomUUID() } as Slot) as Slot);
};

const bind = (path: string, sessionId: string): Binding => {
  const s = slot();
  if (s.binding?.sessionId === sessionId) return s.binding;
  unbind();
  const store = openCrewStore(path);
  try {
    const main = store.ensureMain(sessionId);
    let owner: Owner;
    try { owner = store.claimMain(main.id, s.instanceId); }   // idempotent for this process
    catch (e) {
      if (!/already owned/.test(String(e))) throw e;
      owner = store.reclaimMain(main.id, s.instanceId);       // our session, a stale lease (reload over older code, or a crash)
    }
    s.binding = { sessionId, store, owner };
    s.sessionId = sessionId;
    return s.binding;
  } catch (error) { store.close(); throw error; }
};

const unbind = (): void => {
  const s = slot();
  const old = s.binding;
  s.binding = undefined;
  if (old) {
    try { old.store.releaseMain(old.owner); } catch { /* a lease we already lost is not an error */ }
    finally { try { old.store.close(); } catch { /* closing twice is harmless */ } }
  }
};

export type Registry = ((sessionId?: string) => Binding) & {
  /** Run a write against the binding; if the store rejects our lease as stale, reclaim the row ONCE and retry.
   *  Without this a lease stolen mid-life (a reload racing us, a second process on our session file) fails every
   *  write until the next /reload — only a session-id change rebinds the bare accessor. */
  use<T>(sessionId: string | undefined, fn: (b: Binding) => T): T;
};

export const isStaleOwner = (e: unknown): boolean => /stale or invalid owner/.test(String(e));

export function sharedRegistry(pi: Pick<ExtensionAPI, 'on'>, path: string): Registry {
  pi.on('session_start', (_event, ctx) => { bind(path, ctx.sessionManager.getSessionId()); });
  pi.on('session_shutdown', () => unbind());
  const get = (sessionId?: string): Binding => {
    const s = slot();
    const want = sessionId ?? s.sessionId;
    if (s.binding && (want === undefined || s.binding.sessionId === want)) return s.binding;
    if (want === undefined) throw new Error('registry not initialized: no session bound yet');
    return bind(path, want);   // self-healing: a missed or out-of-order session_start rebinds here
  };
  const use = <T,>(sessionId: string | undefined, fn: (b: Binding) => T): T => {
    try { return fn(get(sessionId)); }
    catch (e) {
      if (!isStaleOwner(e)) throw e;
      const want = sessionId ?? slot().sessionId;
      unbind();
      return fn(bind(path, want!));   // claimMain → "already owned" → reclaimMain: the row is ours, the lease was not
    }
  };
  return Object.assign(get, { use });
}

/** Test seam: forget the process binding (a fresh process is the normal reset). */
export function resetSharedRegistry(): void {
  unbind();
  delete (globalThis as Record<symbol, unknown>)[KEY];
}
