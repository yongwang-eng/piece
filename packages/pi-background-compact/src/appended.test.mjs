// Pattern B: the summarizer request IS the live request plus one appended user message, so the
// provider's prompt cache prefix (tools + system + messages) is reused instead of re-bought.
// The one number that proves it in production: the summarizer's usage.cacheRead ≈ context size.
import test from "node:test";
import assert from "node:assert/strict";

const { appendedCompact, buildAppendedContext, sliceDoomed, SUMMARIZE_INSTRUCTION } = await import("./appended.ts");

const prep = { firstKeptEntryId: "e42", tokensBefore: 200_000 };
const llmMessages = [
  { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 },
];
const tools = [
  { name: "read", description: "r", parameters: { a: 1 } },
  { name: "bash", description: "b", parameters: { b: 2 } },
  { name: "inactive", description: "x", parameters: {} },
];
const ctxOf = () => ({
  getSystemPrompt: () => "LIVE SYSTEM PROMPT",
  getAllTools: () => tools,
  getActiveTools: () => ["bash", "read"], // active order ≠ getAllTools order — active order wins
  sessionManager: { getBranch: () => [{ id: "e1", type: "message" }] },
});
const deps = (complete) => ({
  complete,
  entriesToLlm: () => llmMessages,
});
const ok = (text, usage) => ({
  stopReason: "stop",
  content: [{ type: "text", text }],
  usage: usage ?? { input: 10, output: 500, cacheRead: 199_000, cacheWrite: 1_000, cost: { total: 0.31 } },
});
const req = (over = {}) => ({
  prep, model: { id: "m", provider: "anthropic" }, apiKey: "k", headers: { h: "1" }, env: { E: "1" },
  signal: new AbortController().signal, ctx: ctxOf(), maxTokens: 13_107, thinkingLevel: "high", sessionId: "sess-1", ...over,
});

test("request = live prefix untouched + exactly one appended user instruction", async () => {
  const calls = [];
  const r = await appendedCompact(deps(async (...a) => (calls.push(a), ok("SUMMARY"))), req());
  assert.equal(calls.length, 1);
  const [, context, options] = calls[0];
  assert.equal(context.systemPrompt, "LIVE SYSTEM PROMPT");
  assert.deepEqual(context.messages.slice(0, -1), llmMessages, "live messages are not rewritten");
  const last = context.messages.at(-1);
  assert.equal(last.role, "user");
  assert.ok(last.content[0].text.includes("conversation to summarize"));
  assert.deepEqual(context.tools.map((t) => t.name), ["bash", "read"], "active tools, active order — the cache prefix");
  assert.equal(options.cacheRetention, "short");
  assert.equal(options.reasoning, "high", "MUST mirror the session thinking level — a thinking change invalidates Anthropic's message cache");
  assert.equal(options.maxTokens, 13_107);
  assert.equal(options.apiKey, "k");
  assert.equal(options.sessionId, "sess-1", "OpenAI routes the prompt cache by prompt_cache_key = options.sessionId; without it the identical prefix is a guaranteed miss");
  assert.equal(r.summary, "SUMMARY");
  assert.equal(r.firstKeptEntryId, "e42");
  assert.equal(r.tokensBefore, 200_000);
  assert.equal(r.usage.cost.total, 0.31);
});

test("thinking off stays off — no reasoning field", async () => {
  const calls = [];
  await appendedCompact(deps(async (...a) => (calls.push(a), ok("S"))), req({ thinkingLevel: "off" }));
  assert.equal(calls[0][2].reasoning, undefined);
});

test("a toolUse answer retries ONCE with a firmer instruction on the same prefix", async () => {
  const calls = [];
  const r = await appendedCompact(deps(async (...a) => {
    calls.push(a);
    return calls.length === 1 ? { stopReason: "toolUse", content: [], usage: ok("").usage } : ok("SECOND");
  }), req());
  assert.equal(calls.length, 2);
  const firstInstr = calls[0][1].messages.at(-1).content[0].text;
  const secondInstr = calls[1][1].messages.at(-1).content[0].text;
  assert.notEqual(firstInstr, secondInstr);
  assert.ok(secondInstr.includes("Do NOT call tools"));
  assert.deepEqual(calls[1][1].messages.slice(0, -1), llmMessages, "prefix identical → still a cache hit");
  assert.equal(r.summary, "SECOND");
  assert.ok(r.usage.cost.total > 0.31, "both attempts are billed into one usage");
});

test("an error or empty answer throws — the service reports failed, nothing blocks", async () => {
  await assert.rejects(
    () => appendedCompact(deps(async () => ({ stopReason: "error", errorMessage: "refused", content: [] })), req()),
    /refused/);
  await assert.rejects(
    () => appendedCompact(deps(async () => ok("")), req()),
    /empty summary/);
});

test("a length stop is NOT a summary — a truncated checkpoint must never replace live context", async () => {
  // pi's own getSummarizationFailure refuses this: "A length stop contains partial text and
  // must not become a session checkpoint." Accepting it splices a summary that can silently
  // drop goals/constraints, and the ledger it replaced is gone from the live context.
  await assert.rejects(
    () => appendedCompact(deps(async () => ({
      stopReason: "length",
      content: [{ type: "text", text: "Goals: ship the thing. Constraints: do not bre" }],
      usage: { input: 2, output: 13_107, cacheRead: 191_000, cacheWrite: 0, cost: { total: 0.4 } },
    })), req()),
    /token cap|incomplete|length/);
});

test("buildAppendedContext is pure and instruction is pi's proven prompt shape", () => {
  const c = buildAppendedContext({ systemPrompt: "S", messages: llmMessages, tools: [tools[0]], instruction: SUMMARIZE_INSTRUCTION });
  assert.equal(c.messages.length, llmMessages.length + 1);
  assert.ok(SUMMARIZE_INSTRUCTION.includes("## Goal"), "same checkpoint structure the rest of pi expects");
});

test("summarizer input is truncated at the kept boundary (probe-verified: interior cache entries stay warm)", async () => {
  const seen = [];
  const d = { complete: async () => ok("SUMMARY"), entriesToLlm: (_ctx, firstKeptEntryId) => (seen.push(firstKeptEntryId), llmMessages) };
  await appendedCompact(d, req());
  assert.deepEqual(seen, ["e42"], "prep.firstKeptEntryId flows to the message builder");
});

test("sliceDoomed: everything strictly before the kept entry; unknown or leading id falls back to the full ledger", () => {
  const entries = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(sliceDoomed(entries, "c").map((e) => e.id), ["a", "b"]);
  assert.deepEqual(sliceDoomed(entries, "zzz").map((e) => e.id), ["a", "b", "c", "d"], "unknown id → pattern B (full ledger)");
  assert.deepEqual(sliceDoomed(entries, "a").map((e) => e.id), ["a", "b", "c", "d"], "nothing doomed → full ledger, never an empty request");
  assert.deepEqual(sliceDoomed(entries, undefined).map((e) => e.id), ["a", "b", "c", "d"]);
});
