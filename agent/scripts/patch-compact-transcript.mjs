#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const piBin = execFileSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
const bundleDir = dirname(await realpath(piBin));
const distDir = dirname(bundleDir);

const sourcePatches = [
  {
    path: join(distDir, "modes/interactive/components/assistant-message.js"),
    stock: `        const hasVisibleContent = message.content.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));\n        if (hasVisibleContent) {\n            this.contentContainer.addChild(new Spacer(1));\n        }`,
    styled: `        const hasVisibleContent = message.content.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));\n        const hasVisibleText = message.content.some((c) => c.type === "text" && c.text.trim());\n        const needsLeadingSpace = hasVisibleContent && (!this.hideThinkingBlock || hasVisibleText);\n        if (needsLeadingSpace) {\n            this.contentContainer.addChild(new Spacer(1));\n        }`,
  },
  {
    path: join(distDir, "modes/interactive/components/tool-execution.js"),
    stock: `            if (contentLines.length > 0) {\n                lines.push("");\n                lines.push(...contentLines);\n            }`,
    styled: `            if (contentLines.length > 0) {\n                lines.push(...contentLines);\n            }`,
  },
];

const bundleFiles = (await readdir(join(bundleDir, "chunks")))
  .filter((name) => name.endsWith(".js"))
  .map((name) => join(bundleDir, "chunks", name));
const bundlePatches = [
  {
    stock: `this.contentContainer.clear(),message.content.some(c2=>c2.type==="text"&&c2.text.trim()||c2.type==="thinking"&&c2.thinking.trim())&&this.contentContainer.addChild(new Spacer(1));let thinkingRunIndex=0`,
    styled: `this.contentContainer.clear();let hasVisibleContent=message.content.some(c2=>c2.type==="text"&&c2.text.trim()||c2.type==="thinking"&&c2.thinking.trim()),hasVisibleText=message.content.some(c2=>c2.type==="text"&&c2.text.trim()),needsLeadingSpace=hasVisibleContent&&(!this.hideThinkingBlock||hasVisibleText);needsLeadingSpace&&this.contentContainer.addChild(new Spacer(1));let thinkingRunIndex=0`,
  },
  {
    stock: `contentLines.length>0&&(lines.push(""),lines.push(...contentLines));`,
    styled: `contentLines.length>0&&lines.push(...contentLines);`,
  },
];

async function apply(path, patch) {
  const source = await readFile(path, "utf8");
  if (source.includes(patch.styled)) return "already";
  if (!source.includes(patch.stock)) return "missing";
  await writeFile(path, source.replace(patch.stock, patch.styled));
  return "patched";
}

let patched = 0;
for (const patch of sourcePatches) {
  const result = await apply(patch.path, patch);
  if (result === "missing") throw new Error(`Renderer signature not found in ${patch.path}; inspect the new pi version.`);
  if (result === "patched") patched++;
}
for (const patch of bundlePatches) {
  let found = false;
  for (const path of bundleFiles) {
    const result = await apply(path, patch);
    if (result !== "missing") found = true;
    if (result === "patched") patched++;
  }
  if (!found) throw new Error("Bundled renderer signature not found; inspect the new pi version.");
}

console.log(patched ? `compact transcript patched (${patched} replacements)` : "compact transcript already patched");
