// One-way latency, publisher → subscriber handler, over the local Redis. Two shapes:
//   in-process:    one client publishes, another client in the SAME process receives (clock: performance.now)
//   cross-process: a child process subscribes and echoes; here we measure the full round trip / 2 (same wall clock, hrtime-safe)
// Run from the package dir: node bench/latency.mjs [n=2000]
import { createPubSub, loadPubSubConfig } from "../src/index.ts";
import { spawn } from "node:child_process";

const N = Number(process.argv[2] ?? 2000);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const report = (label, xs) => console.log(`${label.padEnd(36)} n=${xs.length}  p50=${pct(xs, .5).toFixed(3)}ms  p95=${pct(xs, .95).toFixed(3)}ms  p99=${pct(xs, .99).toFixed(3)}ms  max=${Math.max(...xs).toFixed(3)}ms`);
const config = loadPubSubConfig();
const topic = `bench.${Date.now().toString(36)}`;

// ── in-process one-way ──
{
  const pub = createPubSub({ ...config, clientName: "bench-pub" }), sub = createPubSub({ ...config, clientName: "bench-sub" });
  await pub.connect(); await sub.connect();
  const lat = []; let resolveDone; const done = new Promise((r) => (resolveDone = r));
  await sub.subscribe(topic, (m) => { lat.push(performance.now() - m.payload.t); if (lat.length === N) resolveDone(); });
  const ack = [];
  for (let i = 0; i < N; i++) { const t0 = performance.now(); await pub.publish(topic, { id: `b${i}`, senderId: "bench", payload: { t: performance.now() } }); ack.push(performance.now() - t0); }
  await done;
  report("in-process one-way (publish→handler)", lat);
  report("publish→Redis ack (what room_publish logs)", ack);
  await pub.close(); await sub.close();
}

// ── cross-process round trip (echo child) ──
{
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createPubSub, loadPubSubConfig } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).pathname)};
    const c = createPubSub({ ...loadPubSubConfig(), clientName: "bench-echo" }); await c.connect();
    await c.subscribe(${JSON.stringify(topic + ".ping")}, (m) => c.publish(${JSON.stringify(topic + ".pong")}, { id: m.id, senderId: "echo", payload: m.payload }).catch(() => {}));
    process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`], { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => child.stdout.once("data", r));
  const me = createPubSub({ ...config, clientName: "bench-rt" }); await me.connect();
  const rtt = []; let resolveDone; const done = new Promise((r) => (resolveDone = r));
  await me.subscribe(`${topic}.pong`, (m) => { rtt.push(performance.now() - m.payload.t); if (rtt.length === N) resolveDone(); });
  for (let i = 0; i < N; i++) await me.publish(`${topic}.ping`, { id: `r${i}`, senderId: "bench", payload: { t: performance.now() } });
  await done;
  report("cross-process round trip (ping→pong)", rtt);
  report("cross-process one-way (≈ rtt/2)", rtt.map((x) => x / 2));
  await me.close(); child.kill();
}
