// Open (create) the agent store and report the table count — proof the sqlite schema is produced from the DDL on an empty machine.
import { DatabaseSync } from "node:sqlite";
const agent = process.argv[2];
const m = await import(`${agent}/lib/database/store.ts`);
const p = m.agentDbPath(agent); m.openCrewStore(p).close?.();
const db = new DatabaseSync(p);
const n = db.prepare("select count(*) as n from sqlite_master where type = 'table'").get().n; db.close();
if (n < 1) { console.error("✕ no tables created at", p); process.exit(1); }
console.log(`  ${p} · ${n} tables`);
