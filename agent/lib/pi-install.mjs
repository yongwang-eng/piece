// Where pi itself is installed — for tests that read pi's shipped files (a theme, its dist) outside a pi process.
// Resolved from the `pi` on PATH (a symlink into the global node_modules), so it holds across machines and node versions.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function piInstallDir() {
  const bin = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
  let d = dirname(realpathSync(bin));                       // …/pi-coding-agent/dist/cli.js → dist
  while (d !== "/" && !d.endsWith("pi-coding-agent")) d = dirname(d);
  if (d === "/") throw new Error(`pi install dir not found from ${bin}`);
  return resolve(d);
}
