import { readFile, writeFile, readdir, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const piBin = execFileSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
const chunksDir = join(dirname(await realpath(piBin)), "chunks");
const files = (await readdir(chunksDir)).filter((name) => name.endsWith(".js"));
const stock = 'let text=theme.fg("dim",`Steering: ${message}`);';
const styled = 'let text=theme.bold(theme.fg("accent","↳ STEER"))+theme.fg("text",`  ${message}`);';
let foundStyled = false;
let patched = false;

for (const name of files) {
  const path = join(chunksDir, name);
  const source = await readFile(path, "utf8");
  if (source.includes(styled)) {
    foundStyled = true;
    continue;
  }
  if (!source.includes(stock)) continue;
  await writeFile(path, source.replace(stock, styled));
  patched = true;
}

if (!patched && !foundStyled) {
  throw new Error("Steering renderer signature not found; pi likely changed. Inspect before updating this patch.");
}

console.log(patched ? "steering renderer patched" : "steering renderer already patched");
