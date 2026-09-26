/**
 * Summarize by APPENDING one instruction to the live prefix instead of re-serializing the
 * conversation under a summarizer system prompt. The whole economic claim rests on the prefix
 * still matching what the provider cached, so anything that changes it — a different model, a
 * different thinking configuration, rewritten tools/system — turns a cacheRead into full input
 * price. That is why the caller must pass the SESSION's model and thinking level, not a cheaper
 * summarizer's. The realised `usage.cacheRead` is logged so the claim stays checkable.
 *
 * Input is truncated at `firstKeptEntryId`: the summarizer must not see the entries that survive
 * verbatim, or summary and kept tail would say the same thing twice.
 */

export type LlmMessage = { role: string; content: unknown[]; timestamp?: number };
type ToolInfo = { name: string; description?: string; parameters?: unknown };
type Completion = { stopReason: string; errorMessage?: string; content: Array<{ type: string; text?: string }>; usage?: UsageIn };
type UsageIn = { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number } };

export type AppendedDeps = {
  complete: (model: unknown, context: unknown, options: Record<string, unknown>) => Promise<Completion>;
  /** ctx branch entries → LLM messages, exactly as the live loop does it (buildContextEntries → sessionEntryToContextMessages → convertToLlm). */
  entriesToLlm: (ctx: AppendedCtx, firstKeptEntryId?: string) => LlmMessage[];
};

export type AppendedCtx = {
  getSystemPrompt(): string;
  getAllTools(): ToolInfo[];
  getActiveTools(): string[];
};

export type AppendedRequest = {
  prep: { firstKeptEntryId: string; tokensBefore: number };
  model: unknown;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  signal?: AbortSignal;
  ctx: AppendedCtx;
  sessionId?: string;
  maxTokens: number;
  /** Branch messages captured with `prep` and the fingerprint, before any yield. */
  messages?: LlmMessage[];
  /** The SESSION's thinking level. Anthropic invalidates the MESSAGE cache when thinking parameters
   *  change (tools/system spans survive — which is why the cache-probe, whose cached span was all
   *  system, wrongly measured thinking as cache-neutral). Mirror the live value or lose the prefix. */
  thinkingLevel?: unknown;
};

/** pi's own compaction prompt (dist/core/compaction/compaction.js, not exported) — written to sit
 *  AFTER the conversation, which is exactly where Pattern B puts it. Kept verbatim so summaries
 *  keep the checkpoint structure every other part of the system already expects. */
export const SUMMARIZE_INSTRUCTION = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
const UPDATE_SUMMARIZATION_INSTRUCTIONS = \`Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const RETRY_INSTRUCTION = `${SUMMARIZE_INSTRUCTION}

IMPORTANT: Do NOT call tools. Reply with ONLY the summary text in the format above.`;

export function buildAppendedContext(args: { systemPrompt: string; messages: LlmMessage[]; tools: ToolInfo[]; instruction: string }) {
  return {
    systemPrompt: args.systemPrompt,
    messages: [...args.messages, { role: "user", content: [{ type: "text", text: args.instruction }], timestamp: Date.now() }],
    tools: args.tools,
  };
}

const addUsage = (a: UsageIn | undefined, b: UsageIn | undefined): UsageIn | undefined => {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input, output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: { total: (a.cost?.total ?? 0) + (b.cost?.total ?? 0) },
  };
};

/** Entries strictly before the kept boundary. Unknown or leading id → the full ledger:
 *  degrade to pattern B rather than summarize nothing or lose the request. */
export function sliceDoomed<T extends { id?: string }>(entries: T[], firstKeptEntryId?: string): T[] {
  if (!firstKeptEntryId) return entries;
  const cut = entries.findIndex((e) => e.id === firstKeptEntryId);
  return cut > 0 ? entries.slice(0, cut) : entries;
}

export async function appendedCompact(deps: AppendedDeps, req: AppendedRequest) {
  const { ctx } = req;
  const byName = new Map(ctx.getAllTools().map((t) => [t.name, t]));
  // Active tools in ACTIVE order — the tools array is the first bytes of the cache prefix.
  const tools = ctx.getActiveTools().map((n) => byName.get(n)).filter((t): t is ToolInfo => !!t);
  // The caller's snapshot wins. Re-reading the branch here would summarize whatever is live NOW,
  // which the fingerprint does not authenticate — a branch switch during auth would splice one
  // conversation's summary into another. entriesToLlm is the fallback for callers without a snapshot.
  const messages = req.messages ?? deps.entriesToLlm(ctx, req.prep.firstKeptEntryId);
  // sessionId becomes OpenAI's prompt_cache_key: same prefix under a different key is routed
  // to a different cache and misses in full. Anthropic keys on content and ignores it.
  const options: Record<string, unknown> = {
    apiKey: req.apiKey, headers: req.headers, env: req.env, signal: req.signal,
    maxTokens: req.maxTokens, cacheRetention: "short", sessionId: req.sessionId,
  };
  if (req.thinkingLevel && req.thinkingLevel !== "off") options.reasoning = req.thinkingLevel;

  let usage: UsageIn | undefined;
  for (const instruction of [SUMMARIZE_INSTRUCTION, RETRY_INSTRUCTION]) {
    const context = buildAppendedContext({ systemPrompt: ctx.getSystemPrompt(), messages, tools, instruction });
    const r = await deps.complete(req.model, context, options);
    usage = addUsage(usage, r.usage);
    if (r.stopReason === "error" || r.stopReason === "aborted") throw new Error(r.errorMessage || `summarizer ${r.stopReason}`);
    // A length stop is an incomplete checkpoint; never let one replace live context. Throwing hands
    // the attempt to pi's summarizer instead of committing partial text. Note `maxTokens` is derived
    // from core's reserveTokens and thinking tokens share it, so a higher level caps sooner.
    if (r.stopReason === "length") throw new Error("summarizer generation hit the token cap and the summary is incomplete");
    if (r.stopReason === "toolUse") continue; // same prefix, firmer instruction — still one cache hit
    const summary = r.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    if (!summary) throw new Error("summarizer returned an empty summary");
    return { summary, firstKeptEntryId: req.prep.firstKeptEntryId, tokensBefore: req.prep.tokensBefore, usage };
  }
  throw new Error("summarizer insisted on calling tools twice; giving up");
}
