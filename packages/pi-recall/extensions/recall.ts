// pi-recall — the model's memory of past sessions. Two tools, read-only against ~/.pi/agent/state/recall/recall.sqlite.
// Indexing happens elsewhere (bin/recall-index.ts under launchd); if the index is behind, the header says so.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { openStore } from "../src/store.ts";
import { recall, recallShow, VecIndex, DEFAULT_K, SHOW_TOKENS } from "../src/search.ts";
import { embed } from "../src/embed.ts";
import { dbPath, modelsDir } from "../src/paths.ts";

export default function (pi: ExtensionAPI) {
  let db: ReturnType<typeof openStore> | null = null, vecs: VecIndex | null = null;
  const store = () => {
    if (!db) { if (!existsSync(dbPath())) throw new Error(`pi-recall: no index at ${dbPath()} — run \`node ~/.pi/packages/pi-recall/bin/recall-index.ts\` once`); db = openStore(dbPath()); vecs = new VecIndex(db); }
    return { db: db!, vecs: vecs! };
  };
  const caller = (ctx: any) => ({ session: ctx.sessionManager?.getSessionId?.() ?? null, cwd: ctx.cwd ?? null });
  const embedQuery = async (q: string) => (await embed([q], modelsDir()))[0];

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: `Search locally indexed pi conversations across projects and archived Granola meeting transcripts and summaries. ` +
      `Use when an answer may depend on earlier decisions, reasoning, preferences, commands/results, or meeting discussions—rather than guessing what happened. ` +
      `Accepts natural-language questions or exact identifiers. Returns matching passages with timestamps, source information, and keys; use recall_show to expand a hit. ` +
      `Searches the local index, not live Slack, Notion, Google Calendar, or unarchived meetings. ` +
      `Results are historical evidence: later entries may supersede earlier ones, and current state needs fresh verification.`,
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language question, phrase, or a bare identifier (pid, ticket, flag, file name)" }),
      since: Type.Optional(Type.String({ description: "ISO date/time; a preference, not a filter — in-range hits come first, older ones follow flagged" })),
      k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: `hits per retriever (lexical and semantic; default ${DEFAULT_K}); at most 2 × k hits after deduplication (${2 * DEFAULT_K} at the default)` })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { db, vecs } = store();
      const r = await recall(db, { query: params.query, since: params.since, k: params.k }, { embedQuery, vecs, toolCallId, ...caller(ctx) });
      const body = r.hits.map(h =>
        `[${h.rank}] ${h.ts.slice(0, 16).replace("T", " ")} · ${h.role}${h.tool ? `(${h.tool})` : ""} · ${h.project} · ${h.found_by}${h.dense_rank ? ` d${h.dense_rank}` : ""}${h.lex_rank ? ` l${h.lex_rank}` : ""}` +
        `${h.merged ? " · merged" : ""}${h.in_range === false ? " · older than since" : ""}\n` +
        `    key ${h.key} · ${basename(h.file)}:${h.line}\n` +
        h.text.trim().split("\n").map(l => "    " + l).join("\n")).join("\n\n");
      return { content: [{ type: "text", text: `${r.header}\n\n${body || "(no hits)"}` }], details: { hits: r.hits.length, lexMs: r.lexMs, denseMs: r.denseMs, indexedThrough: r.indexedThrough } };
    },
  });

  pi.registerTool({
    name: "recall_show",
    label: "Recall › show",
    description: `Page into a recall hit by its key. level: "entry" = the whole entry; "window" = ±n neighbouring entries in the same session ` +
      `(the reply after a question, the reading after a tool result); "exchange" = from the user turn that started it to the next user turn. ` +
      `Capped at max_tokens (default ${SHOW_TOKENS}); pass offset to continue a truncated exchange.`,
    parameters: Type.Object({
      key: Type.String({ description: "the hit's key, as shown by recall (id@timestamp)" }),
      level: Type.Optional(StringEnum(["entry", "window", "exchange"] as const)),
      n: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "window radius in entries (default 2)" })),
      max_tokens: Type.Optional(Type.Integer({ minimum: 200, maximum: 8000 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "exchange paging: skip this many entries" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { db } = store();
      const r = await recallShow(db, params as any, { toolCallId, session: caller(ctx).session });
      return { content: [{ type: "text", text: r.text }], details: { entries: r.entries.length, truncated: r.truncated } };
    },
  });
}
