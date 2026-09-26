#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

const piBin = execFileSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
const bundleDir = dirname(await realpath(piBin));
const componentsDir = join(dirname(bundleDir), "modes/interactive/components");
const assistant = await readFile(join(componentsDir, "assistant-message.js"), "utf8");
const tools = await readFile(join(componentsDir, "tool-execution.js"), "utf8");

if (!assistant.includes("const needsLeadingSpace = hasVisibleContent && (!this.hideThinkingBlock || hasVisibleText);")) {
  throw new Error("assistant messages still reserve a blank row for collapsed thinking");
}
if (tools.includes('lines.push("");\n                lines.push(...contentLines);')) {
  throw new Error("self-rendered tools still reserve a blank row before every tool");
}
if (!tools.includes("lines.push(...contentLines);")) {
  throw new Error("tool self-render path not found");
}

const chunksDir = join(bundleDir, "chunks");
const chunks = await Promise.all(
  (await readdir(chunksDir))
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFile(join(chunksDir, name), "utf8")),
);
const bundle = chunks.join("\n");
if (!bundle.includes("needsLeadingSpace=hasVisibleContent&&(!this.hideThinkingBlock||hasVisibleText)")) {
  throw new Error("runtime bundle is missing compact collapsed-thinking layout");
}
if (bundle.includes('contentLines.length>0&&(lines.push(""),lines.push(...contentLines));')) {
  throw new Error("runtime bundle still reserves a blank row before self-rendered tools");
}

console.log("compact transcript layout: PASS");
