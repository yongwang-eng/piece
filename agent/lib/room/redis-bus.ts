/**
 * RedisRoomBus — the room's transport over pi-pubsub (local Redis Pub/Sub). Same `attach(name, onEvent)` seam as
 * LocalBus, so RoomClient needs no transport-specific code: one exact topic per run, every member subscribes to it,
 * the envelope's `to` decides who acts (lanes.ts) — unicast, multicast and broadcast are all one publish.
 *
 * Contract (V1, live-only): a message reaches the members subscribed at the instant of publish and nobody else.
 * `publish` throws until the subscription is acknowledged and while Redis is unreachable — nothing is queued here.
 * `onPublish` reports how many subscriber connections Redis handed each envelope to: 0 on a directed message is the
 * F12 symptom ("task delivered" to a worker that could not receive) caught at the moment it happens.
 */
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { RoomChannel } from "./types.ts";
import { createPubSub, loadPubSubConfig, type PubSub, type PubSubOptions } from "../../../packages/pi-pubsub/src/index.ts";

export type BusEvent = { type: "message"; payload: unknown; from: string };
export type BusListener = (ev: BusEvent) => void;

export interface RedisRoomBusOptions {
  run: string;
  runDir: string;
  /** injected client (tests); default: a fresh pi-pubsub client from config/pubsub.json */
  pubsub?: PubSub;
  /** applied when the bus creates its own client */
  clientOptions?: Partial<PubSubOptions>;
  /** connect/subscribe/publish failures — the bus never throws into RoomClient */
  onError?: (stage: "connect" | "subscribe" | "publish", error: Error) => void;
  /** every publish outcome: Redis's subscriber count and the publish→ack round trip in ms */
  onPublish?: (payload: unknown, result: { subscribers: number; elapsedMs: number }) => void;
}

/** `crew.<32 hex of sha256(run\0runDir)>.<run>` — unique per (run, runDir) like RoomClient.namespace, readable at the tail. */
export function roomTopic(run: string, runDir: string): string {
  const hash = createHash("sha256").update(`${run}\0${resolve(runDir)}`).digest("hex").slice(0, 32);
  const tail = run.toLowerCase().replace(/[^a-z0-9._:-]/g, "-").slice(0, 40);
  return `crew.${hash}.${tail}`;
}

/** CLIENT SETNAME allows no spaces; a run id never has one, but a name is user input in some paths. */
const clientPrefix = (run: string) => `crew:${run.replace(/\s+/g, "_")}`;

export class RedisRoomBus {
  readonly topic: string;
  private pubsub?: PubSub;
  private owned = false;
  private connected = false;
  private subscription?: { unsubscribe(): Promise<void> };
  private name?: string;
  private readonly o: RedisRoomBusOptions;

  constructor(o: RedisRoomBusOptions) {
    this.o = o;
    this.topic = roomTopic(o.run, o.runDir);
  }

  /** Is this member able to receive right now (subscription acknowledged, connection up)? */
  isConnected(): boolean { return this.connected; }

  /** Member names currently CONNECTED to Redis for this run — liveness observed from the kernel, never claimed. */
  async peers(): Promise<string[]> {
    if (!this.connected || !this.pubsub) return [];
    const prefix = `${clientPrefix(this.o.run)}:`;
    return (await this.pubsub.clientNames()).filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length));
  }

  /**
   * Returns the channel immediately; connects and subscribes in the background. `onReady` fires when the subscription
   * is acknowledged — and again after every reconnect, once node-redis has restored it — so the caller can flush.
   */
  attach(name: string, onEvent: BusListener, onReady?: () => void): RoomChannel {
    if (this.name) throw new Error(`redis-bus: already attached as ${this.name}`);
    this.name = name;
    void this.start(name, onEvent, onReady);
    const bus = this;
    return {
      namespace: this.topic,
      snapshot: () => ({ connected: bus.connected }),
      publish(payload: unknown) {
        if (!bus.connected || !bus.pubsub) throw new Error(`redis-bus: not connected to ${bus.topic}`);
        const id = typeof (payload as any)?.id === "string" ? (payload as any).id : randomUUID();
        const t0 = performance.now();
        bus.pubsub.publish(bus.topic, { id, senderId: name, payload })
          .then((r) => bus.o.onPublish?.(payload, { ...r, elapsedMs: Math.round((performance.now() - t0) * 100) / 100 }))
          .catch((e) => bus.o.onError?.("publish", e as Error));
      },
    };
  }

  private async start(name: string, onEvent: BusListener, onReady?: () => void) {
    let pubsub = this.o.pubsub;
    if (!pubsub) {
      try { pubsub = createPubSub({ ...loadPubSubConfig(), clientName: `${clientPrefix(this.o.run)}:${name}`, ...this.o.clientOptions }); }
      catch (e) { this.o.onError?.("connect", e as Error); return; }
      this.owned = true;
    }
    this.pubsub = pubsub;
    if (pubsub.status === "idle") {
      try { await pubsub.connect(); } catch (e) { this.o.onError?.("connect", e as Error); return; }
    }
    try {
      this.subscription = await pubsub.subscribe(this.topic, (m) => {
        if (m.senderId === name) return;                                  // own echo: Redis fans out to the sender too
        onEvent({ type: "message", payload: m.payload, from: m.senderId });
      });
    } catch (e) { this.o.onError?.("subscribe", e as Error); return; }
    this.connected = true;
    onReady?.();
    // node-redis restores subscriptions before reporting ready again, so ready ⇒ receivable.
    pubsub.onStatus((s) => {
      const was = this.connected;
      this.connected = s === "ready";
      if (this.connected && !was) onReady?.();
    });
  }

  async detach() {
    this.connected = false;
    try { await this.subscription?.unsubscribe(); } catch { /* connection may already be gone */ }
    this.subscription = undefined;
    if (this.owned && this.pubsub) await this.pubsub.close();
    this.pubsub = undefined;
  }
}
