import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UnmarkedPasteGuard } from "../paste-guard.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("unmarked multiline paste guard", () => {
  it("turns a rapid Enter-followed-by-text burst into a pasted newline", () => {
    const emitted: string[] = [];
    const guard = new UnmarkedPasteGuard(20);

    assert.equal(guard.handle("\r", (data) => emitted.push(data)), true);
    assert.equal(guard.handle("next line", (data) => emitted.push(data)), false);
    assert.deepEqual(emitted, ["\x1b[200~\n\x1b[201~"]);
  });

  it("preserves an ordinary Enter as submit", async () => {
    const emitted: string[] = [];
    const guard = new UnmarkedPasteGuard(5);

    assert.equal(guard.handle("\r", (data) => emitted.push(data)), true);
    await sleep(15);
    assert.deepEqual(emitted, ["\r"]);
  });

  it("leaves ordinary input and bracketed paste untouched", () => {
    const emitted: string[] = [];
    const guard = new UnmarkedPasteGuard(20);

    assert.equal(guard.handle("x", (data) => emitted.push(data)), false);
    assert.equal(guard.handle("\x1b[200~a\nb\x1b[201~", (data) => emitted.push(data)), false);
    assert.deepEqual(emitted, []);
  });
});
