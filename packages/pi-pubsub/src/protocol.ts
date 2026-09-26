/**
 * Wire shape for pi-pubsub. Transport-level only: who sent it, an id to correlate on, an opaque payload.
 * No agent semantics live here — addressing, performatives and delivery lanes belong to the caller.
 */

export const PROTOCOL_VERSION = 1;

/** Redis channel name. Lowercase, dotted, no wildcards — a topic is always an exact subscription. */
export const TOPIC_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

/** Hard cap on one encoded message. Pub/Sub is for envelopes and notices, not artifacts. */
export const MAX_ENCODED_BYTES = 1024 * 1024;

export interface Message {
  id: string;
  senderId: string;
  /** ISO timestamp set by the publisher */
  sentAt: string;
  /** id of the message this answers, when the caller's protocol correlates replies */
  replyTo?: string;
  payload: unknown;
}

interface Wire extends Message {
  v: typeof PROTOCOL_VERSION;
}

export function validateTopic(topic: string): string | undefined {
  if (typeof topic !== "string" || !TOPIC_PATTERN.test(topic)) {
    return `topic must match ${TOPIC_PATTERN} (got ${JSON.stringify(topic)})`;
  }
  return undefined;
}

export function encodeMessage(message: Message): string {
  if (typeof message.id !== "string" || !message.id) throw new Error("message.id must be a non-empty string");
  if (typeof message.senderId !== "string" || !message.senderId) throw new Error("message.senderId must be a non-empty string");
  const wire: Wire = { v: PROTOCOL_VERSION, id: message.id, senderId: message.senderId, sentAt: message.sentAt, payload: message.payload };
  if (message.replyTo !== undefined) wire.replyTo = message.replyTo;
  const encoded = JSON.stringify(wire);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_ENCODED_BYTES) throw new Error(`message ${message.id} is ${bytes} bytes; the cap is ${MAX_ENCODED_BYTES}`);
  return encoded;
}

/** Returns undefined for anything that is not a well-formed v1 message. Never throws. */
export function decodeMessage(raw: string): Message | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const w = parsed as Record<string, unknown>;
  if (w.v !== PROTOCOL_VERSION) return undefined;
  if (typeof w.id !== "string" || !w.id) return undefined;
  if (typeof w.senderId !== "string" || !w.senderId) return undefined;
  if (typeof w.sentAt !== "string") return undefined;
  if (w.replyTo !== undefined && typeof w.replyTo !== "string") return undefined;
  if (!("payload" in w)) return undefined;
  const message: Message = { id: w.id, senderId: w.senderId, sentAt: w.sentAt, payload: w.payload };
  if (typeof w.replyTo === "string") message.replyTo = w.replyTo;
  return message;
}
