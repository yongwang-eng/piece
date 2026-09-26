// Worker model by profile tier — a list, not a judgement (config/crew_models.json).
// Resolution order: explicit `model` on the spawn > the profile's tier > settings.crew.defaultModel.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ModelRegistry = { tiers: Record<string, { model: string; profiles: string[]; why?: string }> };

const REGISTRY = join(import.meta.dirname, "../../../config/crew_models.json");

export function loadModelRegistry(path = REGISTRY): ModelRegistry {
  try { return JSON.parse(readFileSync(path, "utf8")) as ModelRegistry; } catch { return { tiers: {} }; }
}

export function resolveWorkerModel(p: { model?: string; profile?: string }, reg: ModelRegistry, fallback: string | undefined): string | undefined {
  if (p.model) return p.model;
  if (!p.profile) return fallback;
  const hits = Object.entries(reg.tiers).filter(([, t]) => t.profiles.includes(p.profile!));
  if (hits.length > 1) throw new Error(`crew_models.json: profile "${p.profile}" is in both ${hits.map(([n]) => n).join(" and ")} — list it once`);
  return hits[0]?.[1].model ?? fallback;
}
