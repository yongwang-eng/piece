// Round 7: one state dir, one SQLite file, a durable model cache. PI_AGENT_DIR / PI_RECALL_DB override for tests and scratch.
import { homedir } from "node:os";
import { join } from "node:path";
const agent = () => process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const sessionsRoot = () => join(agent(), "sessions");
export const stateDir = () => join(agent(), "state", "recall");
export const dbPath = () => process.env.PI_RECALL_DB ?? join(stateDir(), "recall.sqlite");
export const modelsDir = () => join(agent(), "state", "models");
export const logPath = () => join(stateDir(), "index.log");
// Source 2: work_hub's meeting-transcript archive; the indexer opens it read-only and skips it when absent.
export const workHubDb = () => process.env.PI_RECALL_WORKHUB_DB ?? join(homedir(), ".work_hub", "data.db");
