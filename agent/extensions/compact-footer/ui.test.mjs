import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fitFooter, visibleWidth } from "../../lib/agent-ui/footer-layout.ts";
import { piInstallDir } from "../../lib/pi-install.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const themePath = resolve(here, "../../themes/yong-claude-quiet.json");
const builtinThemePath = `${piInstallDir()}/dist/modes/interactive/theme/dark.json`;

const [theme, builtin] = await Promise.all([
  readFile(themePath, "utf8").then(JSON.parse),
  readFile(builtinThemePath, "utf8").then(JSON.parse),
]);

assert.equal(theme.name, "yong-claude-quiet");
for (const token of Object.keys(builtin.colors)) {
  assert.ok(token in theme.colors, `missing theme token: ${token}`);
}

const parts = [
  { key: "directory", variants: ["workspace"], required: true },
  { key: "branch", variants: ["⎇ feature/pi-ui"] },
  { key: "model", variants: ["gpt-5.6-sol"], required: true },
  { key: "thinking", variants: ["medium"] },
  { key: "context", variants: ["████░░░░ 50% (100k/200k)", "████░░░░ 50%", "50%"], required: true },
  { key: "cost", variants: ["$0.42"] },
];

const wide = fitFooter(parts, 120);
assert.match(wide, /workspace/);
assert.match(wide, /feature\/pi-ui/);
assert.match(wide, /gpt-5\.6-sol/);
assert.match(wide, /50% \(100k\/200k\)/);
assert.match(wide, /\$0\.42/);
assert.ok(visibleWidth(wide) <= 120);

const narrow = fitFooter(parts, 42);
assert.match(narrow, /workspace/);
assert.match(narrow, /gpt-5\.6-sol/);
assert.match(narrow, /50%/);
assert.ok(visibleWidth(narrow) <= 42);

const tiny = fitFooter(parts, 20);
assert.ok(visibleWidth(tiny) <= 20);

console.log("compact-footer UI regression: PASS");
