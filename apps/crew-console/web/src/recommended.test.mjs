// node --test web/src/recommended.test.mjs — the pure mapping from main's assessment to a button this card offers
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const src = readFileSync(fileURLToPath(new URL("./ConsultCard.tsx", import.meta.url)), "utf8");
const body = /export const recommendedKey = ([\s\S]*?);\nconst primaryKey/.exec(src)[1].replace(/: string \| undefined/g, "").replace(/: string\[\]/g, "").replace(/\): string \| undefined =>/, ") =>");
const recommendedKey = eval(body);

test("main says approve and the card offers approve → approve", () => assert.equal(recommendedKey("approve — do the thing", ["approve", "reject", "show"]), "approve"));
test("main says approve, amended → amend", () => assert.equal(recommendedKey("approve, amended (only staging)", ["approve", "amend", "reject"]), "amend"));
test("c-reviewer-193-1: main says approve, card has no approve → Give direction (prefilled by the card)", () => assert.equal(recommendedKey("approve — test-owned local mutations only", ["answer", "show", "reject"]), "answer"));
test("no answer key and no match → nothing highlighted (never a phantom approve)", () => assert.equal(recommendedKey("approve", ["show", "reject"]), undefined));
test("reject maps to reject; ask first maps to ask", () => { assert.equal(recommendedKey("reject", ["approve", "reject"]), "reject"); assert.equal(recommendedKey("ask first (which branch?)", ["approve", "ask", "reject"]), "ask"); });
