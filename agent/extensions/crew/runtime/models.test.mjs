import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkerModel, loadModelRegistry } from "./models.ts";

const reg = { tiers: { judgment_cross: { model: "cf/sol", profiles: ["critic"] }, mechanical: { model: "cf/terra", profiles: ["implementer", "clerk"] } } };

test("explicit model wins over everything", () => {
  assert.equal(resolveWorkerModel({ model: "x/y", profile: "critic" }, reg, "d/default"), "x/y");
});
test("a listed profile gets its tier's model", () => {
  assert.equal(resolveWorkerModel({ profile: "implementer" }, reg, "d/default"), "cf/terra");
  assert.equal(resolveWorkerModel({ profile: "critic" }, reg, "d/default"), "cf/sol");
});
test("an unlisted profile or an ad-hoc role falls through to crew.defaultModel", () => {
  assert.equal(resolveWorkerModel({ profile: "reviewer" }, reg, "d/default"), "d/default");
  assert.equal(resolveWorkerModel({}, reg, "d/default"), "d/default");
  assert.equal(resolveWorkerModel({}, reg, undefined), undefined);
});
test("a profile listed in two tiers is a config error, not a coin flip", () => {
  const bad = { tiers: { a: { model: "m1", profiles: ["x"] }, b: { model: "m2", profiles: ["x"] } } };
  assert.throws(() => resolveWorkerModel({ profile: "x" }, bad, "d"), /x.*both|twice|a.*b/);
});
test("the real registry loads and every profile in it has a profiles/ dir or is a known lane", () => {
  const r = loadModelRegistry();
  const names = Object.values(r.tiers).flatMap((t) => t.profiles);
  assert.ok(names.includes("implementer") && names.includes("critic"));
  assert.equal(new Set(names).size, names.length, "no profile listed twice");
});
