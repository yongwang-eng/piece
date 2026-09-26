# pi-pubsub

Local pub/sub for pi over a loopback Redis. Transport only: it moves framed messages between connected
processes and says exactly what it did — nothing about what the receiver does with them.

```text
caller (crew room, any local app)
        ↓ subscribe / publish
pi-pubsub client            fail-fast, no queue
        ↓ RESP3, authenticated
Redis  127.0.0.1:16379      Pub/Sub only, persistence off
```

## Contract (V1 — live-only)

| Call | Resolves when | Does NOT mean |
|---|---|---|
| `connect()` | authenticated + ready; rejects within `connectTimeoutMs` | — |
| `subscribe(topic, fn)` | Redis acknowledged the subscription | anyone published yet |
| `publish(topic, msg)` → `{ subscribers }` | Redis handed it to that many subscriber connections | a receiver read, injected or acted on it |
| `status` | `idle · connecting · ready · disconnected · closed` | — |

- Not ready ⇒ `publish` throws `PubSubUnavailableError`. **Nothing is queued anywhere.**
- Reconnect is automatic (capped backoff); subscriptions are restored before `ready` is reported again.
- Messages published while a subscriber was disconnected are gone. That is Redis Pub/Sub, by design.
  If a message must survive a disconnect, that is a V2 question (Redis Streams) — not this package's promise.
- Topics are exact names (`^[a-z0-9][a-z0-9._:-]{0,127}$`), never patterns.
- One message ≤ 1 MiB encoded. A message = `{ id, senderId, sentAt, replyTo?, payload }`; the payload is opaque.

## Config

`~/.pi/agent/config/pubsub.json` (tracked) names the endpoint and *where* the credential lives; the credential
itself is in `~/.config/claude/pi-pubsub.env` (0600, untracked). Loopback hosts only — anything else is refused.

```json
{ "host": "127.0.0.1", "port": 16379, "passwordEnv": "REDISCLI_AUTH", "passwordFile": "~/.config/claude/pi-pubsub.env" }
```

Starting Redis is not this package's job (no launchd, no auto-spawn): see the runbook in the vault,
`pi/design/research/pi_pubsub_local_redis.md`.

## Use

```ts
import { createPubSub, loadPubSubConfig } from "pi-pubsub/src/index.ts";

const bus = createPubSub({ ...loadPubSubConfig(), clientName: "my-app" });
await bus.connect();
await bus.subscribe("crew.abc.crew_3", (m, topic) => console.log(m.senderId, m.payload));
const { subscribers } = await bus.publish("crew.abc.crew_3", { id: "m1", senderId: "main", payload: { hello: 1 } });
```

Crew's adapter is `agent/lib/room/redis-bus.ts` (one exact topic per run; the envelope decides who acts).
Enabled by `settings.crew.transport: "redis"`; absent = pi-intercom's extension channel, unchanged.

## Tests

`npm test` — protocol/config are pure; `client.test.mjs` runs against the live local Redis and **skips visibly**
(with the reason) when it is not running. Dependency: `redis` (node-redis 6) — the offline queue is disabled so
the fail-fast contract holds at both layers.
