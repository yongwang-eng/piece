#!/usr/bin/env node
// The launchd job. Tail the session files, embed what is new, append one log line. Never run from the extension.
//   node bin/recall-index.ts [--rebuild] [--no-embed] [--no-meetings] [--limit N]
import { appendFileSync, mkdirSync } from "node:fs";
import { openStore } from "../src/store.ts";
import { indexTail, indexedThrough } from "../src/indexer.ts";
import { indexMeetings } from "../src/meetings.ts";
import { embedPending } from "../src/embed.ts";
import { sessionsRoot, dbPath, modelsDir, logPath, stateDir, workHubDb } from "../src/paths.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
mkdirSync(stateDir(), { recursive: true });
const t0 = performance.now();
const db = openStore(dbPath());
const tail = indexTail(db, sessionsRoot(), { rebuild: flag("--rebuild") });
const meetings = flag("--no-meetings") ? { meetings: 0, entries: 0, chunks: 0, unchanged: 0 } : indexMeetings(db, workHubDb());
let emb = { embedded: 0, pending: 0 };
if (!flag("--no-embed")) {
  let last = 0;
  emb = await embedPending(db, modelsDir(), { limit: opt("--limit") ? +opt("--limit")! : undefined,
    onBatch: (d, t) => { if (d - last >= 2000 || d === t) { last = d; console.error(`embed ${d}/${t}`); } } });
}
const line = { ts: new Date().toISOString(), ms: Math.round(performance.now() - t0), ...tail, meetings: meetings.meetings, meeting_entries: meetings.entries, meeting_chunks: meetings.chunks, ...emb, indexed_through: indexedThrough(db) };
appendFileSync(logPath(), JSON.stringify(line) + "\n");
console.log(JSON.stringify(line));
