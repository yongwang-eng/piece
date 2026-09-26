import assert from "node:assert/strict";
import test from "node:test";
import { chooseDeadRequestRung } from "./failover.ts";

const initial = { attempt: 1, contextPct: 0, currentModel: "anthropic/current", failoverModels: ["anthropic/current", "anthropic/next", "openai/next"], usedModels: new Set() };
for (const [name, overrides, expected] of [
  ["yong_voice historian after 42 tools at approximately 71% context compacts first", { contextPct: 71 }, { action: "compact" }],
  ["40% compact boundary is inclusive", { contextPct: 40 }, { action: "compact" }],
  ["below boundary chooses next configured model, not a different family", { contextPct: 39.9 }, { action: "failover", model: "anthropic/next" }],
  ["second error fails over even at high context", { attempt: 2, contextPct: 71 }, { action: "failover", model: "anthropic/next" }],
  ["third error gives up despite unused model", { attempt: 3, contextPct: 71 }, { action: "give_up" }],
  ["empty configuration gives up", { failoverModels: [] }, { action: "give_up" }],
  ["current and previously used models are skipped", { usedModels: new Set(["anthropic/next"]) }, { action: "failover", model: "openai/next" }],
  ["exhausted models give up", { usedModels: new Set(["anthropic/next", "openai/next"]) }, { action: "give_up" }],
]) {
  test(name, () => {
    const state = { ...initial, ...overrides };
    const before = [...state.usedModels];
    assert.deepEqual(chooseDeadRequestRung(state), expected);
    assert.deepEqual([...state.usedModels], before, "rung choice never records a dispatched model");
  });
}
