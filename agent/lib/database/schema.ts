import { sql } from '../../npm/crew/node_modules/drizzle-orm/index.js';
import { sqliteTable, integer, text, real, check, primaryKey, index, uniqueIndex, type AnySQLiteColumn } from '../../npm/crew/node_modules/drizzle-orm/sqlite-core/index.js';

export const SCHEMA_VERSION = 10;
export const meta = sqliteTable('crew_meta', {
  version: integer().notNull(),
  namespace: text().notNull().default(sql`(lower(hex(randomblob(16))))`),
});
export const agents = sqliteTable('agents', {
  id: integer().primaryKey({ autoIncrement: true }),
  kind: text({ enum: ['main', 'worker', 'governor'] }).notNull(),
  name: text().notNull(),
  profile: text(),
  session_id: text().unique(),
  predecessor_id: integer().references((): AnySQLiteColumn => agents.id),
  owner_instance: text(),
  generation: integer().notNull().default(0),
  created_at: integer().notNull(),
}, t => [check('agent_safe_id', sql`${t.id} <= 9007199254740991`), check('agent_kind', sql`${t.kind} IN ('main', 'worker', 'governor')`)]);
export const crews = sqliteTable('crews', {
  id: integer().primaryKey({ autoIncrement: true }),
  slug: text().notNull(),
  goal: text().notNull(),
  owner_id: integer().notNull().references(() => agents.id),
  created_at: integer().notNull(),
  closed_at: integer(),
  outcome: text(),
}, t => [check('crew_safe_id', sql`${t.id} <= 9007199254740991`)]);
export const members = sqliteTable('crew_members', {
  crew_id: integer().notNull().references(() => crews.id),
  agent_id: integer().notNull().references(() => agents.id),
}, t => [primaryKey({ columns: [t.crew_id, t.agent_id] }), index('members_by_agent').on(t.agent_id, t.crew_id)]);
export const turns = sqliteTable('turns', {
  id: integer().primaryKey({ autoIncrement: true }),
  turn_key: text().notNull().unique(),
  agent_id: integer().notNull().references(() => agents.id),
  crew_id: integer().references(() => crews.id),
  session_id: text().notNull(),
  started_at: integer(),
  ended_at: integer(),
  outcome: text(),
  tool_count: integer(),
}, t => [index('turns_by_agent').on(t.agent_id, t.id), index('turns_by_crew').on(t.crew_id, t.id)]);
export const calls = sqliteTable('model_calls', {
  id: integer().primaryKey({ autoIncrement: true }),
  turn_id: integer().notNull().unique().references(() => turns.id),
  provider: text(),
  model: text(),
  recorded_at: integer().notNull(),
  stop_reason: text().notNull(),
  input_tokens: integer(),
  output_tokens: integer(),
  reasoning_tokens: integer(),
  cache_read_tokens: integer(),
  cache_write_tokens: integer(),
  total_tokens: integer(),
  context_tokens: integer(),
  duration_ms: integer(),
  thinking_level: text(),
  estimated_cost: real(),
  cost_input: real(),
  cost_output: real(),
  cost_cache_read: real(),
  cost_cache_write: real(),
  cost_source: text().notNull(),
});
export const compactions = sqliteTable('compactions', {
  id: integer().primaryKey({ autoIncrement: true }),
  agent_id: integer().notNull().references(() => agents.id),
  session_id: text().notNull(),
  recorded_at: integer().notNull(),
  reason: text().notNull(),
  from_extension: integer().notNull().default(0),
  /** 0 = a summarizer request that never landed (dropped background result): money spent, ledger unchanged */
  applied: integer().notNull().default(1),
  tokens_before: integer(),
  /** The summarizer's OUTPUT tokens — the summary itself, and nothing else. */
  summary_tokens: integer(),
  /** The post-splice MESSAGE LEDGER (summary + kept tail). Moves with `compaction.keepRecentTokens`,
   *  so it is not a summary size; floor = system+tools rent + this. Null on pre-v5 and non-applied rows. */
  tokens_after: integer(),
  /** Which model summarized. Null pre-v5: cost per compaction spans 7× and was unattributable. */
  model: text(),
  cost: real(),
}, t => [index('compactions_by_agent').on(t.agent_id, t.id)]);

/** Every consult a worker raised, whoever answered it — the permission record the console reads.
 *  `id` is the worker's `c-<name>-<roster id>-<n>`; unique within a crew, so the key is (crew, id).
 *  The `answered` transition is `WHERE state='open'`: main and the console may both try, first writer wins. */
export const consults = sqliteTable('consults', {
  crew_id: integer().notNull().references(() => crews.id),
  id: text().notNull(),
  worker: text().notNull(),
  kind: text().notNull(),
  class: text().notNull(),
  human_required: integer().notNull().default(1),
  question: text().notNull(),
  action_verb: text(),
  action_target: text(),
  action_detail: text(),
  /** JSON arrays / objects; null when the worker gave none */
  evidence: text(),
  intent: text(),
  packet: text(),
  /** a re-consult after the human's "Ask first": the consult it continues, and the worker's reply */
  follow_up_of: text(),
  reply: text(),
  /** json [{who: human|worker, text, at}] — the conversation under ONE act; the act itself never changes in-thread */
  thread: text(),
  state: text({ enum: ['open', 'answered', 'withdrawn'] }).notNull().default('open'),
  asked_at: integer().notNull(),
  answered_at: integer(),
  /** governor · preauthorized · human:console · human:crew_answer · human:cli · human:picker:<key> · withdrawn:<reason> */
  answered_by: text(),
  choice: text(),
  answer: text(),
  /** console launch id + browser user-agent on console answers; null otherwise */
  launch: text(),
  agent: text(),
}, t => [primaryKey({ columns: [t.crew_id, t.id] }), index('consults_open').on(t.state, t.asked_at), index('consults_by_crew').on(t.crew_id, t.asked_at),
  check('consult_state', sql`${t.state} IN ('open', 'answered', 'withdrawn')`)]);

/** D97: a Devin session is a worker whose pane is a URL; its row is shared by every pi process (each writes the rows it
 *  owns) and stays until `signed_off_at`. JSON columns hold structures only the devin extension reads (expect · stage · last).
 *  Metadata only: the conversation itself is mirrored to the vault, never stored here. */
export const devinSessions = sqliteTable('devin_sessions', {
  id: text().primaryKey(),
  kind: text({ enum: ['build', 'ask', 'design'] }).notNull(),
  title: text().notNull(),
  slug: text(),
  url: text().notNull(),
  created_at: integer().notNull(),
  watch: integer().notNull().default(1),
  owner_session: text(),
  owner_pane: text(),
  owner_pid: integer(),
  owner_cwd: text(),
  expect: text(),
  mirror: text(),
  stage: text(),
  round: integer(),
  last: text(),
  question: text(),
  stopped_at: integer(),
  last_msg_count: integer(),
  polled_at: integer(),
  signed_off_at: integer(),
}, t => [index('devin_by_owner').on(t.owner_session), check('devin_kind', sql`${t.kind} IN ('build', 'ask', 'design')`)]);
export const devinEvents = sqliteTable('devin_events', {
  id: integer().primaryKey({ autoIncrement: true }),
  session_id: text().notNull().references(() => devinSessions.id),
  at: integer().notNull(),
  text: text().notNull(),
}, t => [index('devin_events_by_session').on(t.session_id, t.id)]);

/** One time series over both event kinds. Calls carry their turn's agent; compactions sit between turns.
 *  context_tokens on a compaction row = tokens_before (the ledger it replaced). */
export const TIMELINE_VIEW = `
CREATE VIEW IF NOT EXISTS timeline AS
SELECT c.recorded_at AS at, t.agent_id, t.session_id, 'call' AS kind, c.model,
       c.context_tokens, c.output_tokens, c.reasoning_tokens, c.estimated_cost AS cost,
       c.stop_reason AS detail, c.turn_id
FROM model_calls c JOIN turns t ON t.id = c.turn_id
UNION ALL
SELECT k.recorded_at, k.agent_id, k.session_id, 'compaction', k.model,
       k.tokens_before, k.summary_tokens, NULL, k.cost,
       k.reason || CASE k.from_extension WHEN 1 THEN ' (ext)' ELSE '' END || CASE k.applied WHEN 0 THEN ' (dropped)' ELSE '' END, NULL
FROM compactions k;
`;

export const MEMBERSHIP_TRIGGER = `
CREATE TRIGGER worker_single_crew BEFORE INSERT ON crew_members
WHEN (SELECT kind FROM agents WHERE id = NEW.agent_id) != 'main'
AND EXISTS (SELECT 1 FROM crew_members WHERE agent_id = NEW.agent_id AND crew_id != NEW.crew_id)
BEGIN SELECT RAISE(ABORT, 'worker already belongs to another crew'); END;
`;
