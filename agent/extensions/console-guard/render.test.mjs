import test from "node:test";
import assert from "node:assert/strict";
import { render } from "./render.ts";

const URL = "https://auth.mcp.example.com/oauth2/authorize?response_type=code&client_id=client_01M2KKQ4STCZCKYXK87HE56CDA&code_challenge=QyCLWIzsWqlNtXL4ZGNFbyBWgkxAjphgYgqY1so7vFM&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A56146%2Fcallback";
const ADAPTER_MSG = `MCP Auth: Open this URL to authenticate hubmcp:\n${URL}`;

test("the adapter's auth line: first line kept, URL becomes a labelled link, raw URL never rendered", () => {
  const r = render(ADAPTER_MSG, "info");
  assert.equal(r.urls[0], URL);
  assert.ok(r.text.startsWith("MCP Auth: Open this URL to authenticate hubmcp:"), r.text);
  assert.ok(r.text.includes(`\x1b]8;;${URL}\x1b\\`), "OSC-8 link present");
  assert.ok(!r.text.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").includes("code_challenge"), "the URL is only inside the escape, never as text");
  assert.ok(r.text.includes("copied"), "tells you the URL is on the clipboard");
  assert.equal(r.level, "warning", "a message that carries a link needs action: it must persist, not fade from the status line");
});

test("a URL inline in the first line is replaced in place", () => {
  const r = render("see https://example.com/x?y=1 for details", "info");
  assert.ok(!r.text.includes("for details https://"), r.text);
  assert.ok(r.text.includes("\x1b]8;;https://example.com/x?y=1\x1b\\"));
  assert.ok(r.text.endsWith("for details · copied") || r.text.includes("for details"), r.text);
});

test("no URL: first non-empty line, level unchanged, nothing to copy", () => {
  const r = render("\n\nMCP Auth: Token expired for hubmcp, attempting refresh\nsecond line", "info");
  assert.equal(r.text, "MCP Auth: Token expired for hubmcp, attempting refresh");
  assert.equal(r.level, "info");
  assert.deepEqual(r.urls, []);
});

test("long lines are cut BEFORE links are inserted, so an escape is never split", () => {
  const long = "x".repeat(400) + " https://example.com/long";
  const r = render(long, "error");
  const plain = r.text.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\]8;;\x1b\\/g, "");
  assert.ok(plain.length <= 220, `plain length ${plain.length}`);
  assert.equal((r.text.match(/\x1b\]8;;https/g) ?? []).length, 1, "the link survives the cut intact");
  assert.equal(r.level, "error");
});
