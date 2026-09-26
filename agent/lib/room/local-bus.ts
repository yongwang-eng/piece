/**
 * LocalBus — the room's transport for INLINE workers (same process as main): a pair of channels where `publish` on
 * one side is `onEvent` on the other, no broker. `RoomClient` sees the same `RoomChannel` shape RedisRoomBus
 * gives it, so an inline worker joins the room with zero client changes. This is the seam the
 * inline|pane press-test (pi/design/crew_design/front_door.md §4) exists to prove.
 *
 * One bus per run. Main attaches once; each inline worker attaches with its name. Delivery is synchronous and
 * in-order; `audience` is honoured the way the broker does it: "capable" = everyone attached except the sender.
 */
import type { RoomChannel } from "./types.ts";

type Listener = (ev: { type: "message"; payload: unknown; from: string }) => void;

export class LocalBus {
  private members = new Map<string, Listener>();
  constructor(readonly namespace: string) {}

  attach(name: string, onEvent: Listener): RoomChannel {
    this.members.set(name, onEvent);
    const bus = this;
    return {
      namespace: this.namespace,
      snapshot: () => ({ connected: true, supported: true, owner: undefined as any, state: undefined as any }),
      publish(payload: unknown) {
        // deliver to everyone but the sender — asynchronously, so a send inside a handler cannot re-enter it
        for (const [n, l] of bus.members) if (n !== name) queueMicrotask(() => { try { l({ type: "message", payload, from: name }); } catch { /* one bad listener never breaks the bus */ } });
      },
    } as unknown as RoomChannel;
  }

  detach(name: string) { this.members.delete(name); }
  names(): string[] { return [...this.members.keys()]; }
}
