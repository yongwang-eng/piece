/**
 * PubSub — a fail-fast client over one Redis connection (RESP3, so subscribe and publish share it).
 *
 * The contract callers may rely on:
 *   connect()    resolves when authenticated and ready; rejects within `connectTimeoutMs` if Redis is down
 *   subscribe()  resolves when Redis has acknowledged the subscription — only then can this client receive
 *   publish()    resolves with how many connected subscribers Redis handed the message to; it says nothing
 *                about what they did with it. Throws PubSubUnavailableError when not ready: nothing is queued.
 *   status       ready ⇄ disconnected while node-redis reconnects (capped backoff, never gives up);
 *                subscriptions are restored before `ready` is reported again. Messages published while this
 *                client was disconnected are gone — Redis Pub/Sub keeps nothing.
 */
import { createClient, type RedisClientType } from "redis";
import type { PubSubConfig } from "./config.ts";
import { decodeMessage, encodeMessage, validateTopic, type Message } from "./protocol.ts";

export type ConnectionStatus = "idle" | "connecting" | "ready" | "disconnected" | "closed";

export interface PublishResult {
  /** subscriber connections Redis delivered to (includes this client if it is subscribed to the topic) */
  subscribers: number;
}

export interface Subscription {
  readonly topic: string;
  unsubscribe(): Promise<void>;
}

export type MessageHandler = (message: Message, topic: string) => void;

export interface PubSub {
  readonly status: ConnectionStatus;
  connect(): Promise<void>;
  subscribe(topic: string, onMessage: MessageHandler): Promise<Subscription>;
  publish(topic: string, message: Omit<Message, "sentAt"> & { sentAt?: string }): Promise<PublishResult>;
  /** SETNAMEs of every client connected to this Redis (unnamed clients omitted) — a registry the kernel keeps for you */
  clientNames(): Promise<string[]>;
  /** returns the unsubscribe function; the listener is called on every status change */
  onStatus(listener: (status: ConnectionStatus, error?: Error) => void): () => void;
  close(): Promise<void>;
}

export interface PubSubOptions extends PubSubConfig {
  /** CLIENT SETNAME — shows in `CLIENT LIST`, which is how you find out who is connected */
  clientName?: string;
  /** default 5000; the initial connect() rejects after this */
  connectTimeoutMs?: number;
  /** a subscriber callback threw; the exception never reaches node-redis */
  onHandlerError?: (error: Error, topic: string) => void;
  /** a frame on a subscribed topic was not a v1 message; it is dropped */
  onInvalidMessage?: (raw: string, topic: string) => void;
}

export class PubSubUnavailableError extends Error {
  readonly status: ConnectionStatus;
  constructor(status: ConnectionStatus, cause?: Error) {
    super(`pi-pubsub: not connected (status: ${status})${cause ? `: ${cause.message}` : ""}`);
    this.name = "PubSubUnavailableError";
    this.status = status;
  }
}

export function createPubSub(options: PubSubOptions): PubSub {
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  const client: RedisClientType = createClient({
    socket: {
      host: options.host,
      port: options.port,
      connectTimeout: connectTimeoutMs,
      reconnectStrategy: (retries) => Math.min(50 * 2 ** retries, 2000),
    },
    ...(options.password !== undefined ? { password: options.password } : {}),
    ...(options.clientName ? { name: options.clientName } : {}),
    disableOfflineQueue: true,
  });

  let status: ConnectionStatus = "idle";
  let lastError: Error | undefined;
  let closing = false;
  const listeners = new Set<(status: ConnectionStatus, error?: Error) => void>();
  const setStatus = (next: ConnectionStatus, error?: Error) => {
    if (status === next && !error) return;
    status = next;
    for (const l of listeners) { try { l(next, error); } catch { /* a listener must not break the client */ } }
  };

  client.on("error", (e: Error) => { lastError = e; if (status === "ready") setStatus("disconnected", e); });
  client.on("reconnecting", () => setStatus("disconnected", lastError));
  client.on("ready", () => setStatus("ready"));
  client.on("end", () => setStatus(closing ? "closed" : "disconnected", closing ? undefined : lastError));

  const requireReady = () => { if (status !== "ready") throw new PubSubUnavailableError(status, lastError); };

  return {
    get status() { return status; },

    async connect() {
      if (status !== "idle") throw new Error(`pi-pubsub: connect() called in status ${status}`);
      setStatus("connecting");
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`pi-pubsub: no Redis at ${options.host}:${options.port} within ${connectTimeoutMs}ms`)), connectTimeoutMs); });
      try {
        await Promise.race([client.connect(), timeout]);
      } catch (e) {
        closing = true;
        try { client.destroy(); } catch { /* already gone */ }
        setStatus("closed", e as Error);
        throw e;
      } finally { clearTimeout(timer); }
    },

    async subscribe(topic, onMessage) {
      const bad = validateTopic(topic); if (bad) throw new Error(`pi-pubsub: ${bad}`);
      requireReady();
      const listener = (raw: string, channel: string) => {
        const message = decodeMessage(raw);
        if (!message) { options.onInvalidMessage?.(raw, channel); return; }
        try { onMessage(message, channel); } catch (e) { options.onHandlerError?.(e as Error, channel); }
      };
      await client.subscribe(topic, listener);
      return {
        topic,
        async unsubscribe() { if (status === "ready") await client.unsubscribe(topic, listener); },
      };
    },

    async publish(topic, message) {
      const bad = validateTopic(topic); if (bad) throw new Error(`pi-pubsub: ${bad}`);
      requireReady();
      const encoded = encodeMessage({ ...message, sentAt: message.sentAt ?? new Date().toISOString() });
      const subscribers = await client.publish(topic, encoded);
      return { subscribers: Number(subscribers) };
    },

    async clientNames() {
      requireReady();
      const list = String(await client.sendCommand(["CLIENT", "LIST"]));
      return list.split("\n").map((line) => /(?:^| )name=(\S*)/.exec(line)?.[1] ?? "").filter(Boolean);
    },

    onStatus(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },

    async close() {
      if (closing) return;
      closing = true;
      try { await client.close(); } catch { try { client.destroy(); } catch { /* already gone */ } }
      setStatus("closed");
    },
  };
}
