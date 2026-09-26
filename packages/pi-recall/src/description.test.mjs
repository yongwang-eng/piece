import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const { extensions, errors } = await loadExtensions([`${root}extensions/recall.ts`], root);
assert.deepEqual(errors, []);
assert.equal(extensions.length, 1);
const tools = extensions[0].tools;
const recall = tools.get("recall").definition;

test("recall description advertises both local sources, use cases and limits", () => {
  const text = recall.description;
  assert.match(text, /locally indexed pi conversations/i);
  assert.match(text, /archived Granola meeting transcripts and summaries/);
  assert.match(text, /decisions.*reasoning.*preferences.*commands\/results.*meeting discussions/);
  assert.match(text, /natural-language questions or exact identifiers/i);
  assert.match(text, /passages with timestamps, source information, and keys/);
  assert.match(text, /recall_show/);
  assert.match(text, /not live Slack, Notion, Google Calendar, or unarchived meetings/);
  assert.match(text, /later entries may supersede earlier ones/);
  assert.match(text, /current state needs fresh verification/);
});

test("k description spells out the bound instead of the ambiguous 2k", () => {
  const text = recall.parameters.properties.k.description;
  assert.match(text, /2 × k/);
  assert.match(text, /20 at the default/);
  assert.doesNotMatch(text, /\b2k\b/);
});

test("registration and argument contracts are unchanged", () => {
  assert.deepEqual([...tools.keys()], ["recall", "recall_show"]);
  assert.deepEqual(recall.parameters.required, ["query"]);
  assert.deepEqual(Object.keys(recall.parameters.properties), ["query", "since", "k"]);
  assert.equal(recall.parameters.properties.k.minimum, 1);
  assert.equal(recall.parameters.properties.k.maximum, 20);
  assert.match(recall.parameters.properties.since.description, /a preference, not a filter/);
  assert.deepEqual(tools.get("recall_show").definition.parameters.required, ["key"]);
});
