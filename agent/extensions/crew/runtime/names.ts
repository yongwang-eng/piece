import { existsSync, readFileSync, readdirSync } from "node:fs";

export function allocatedNames(dir: string, run: string, current: Iterable<string>): string[] {
  const names = new Set(current);
  const log = `${dir}/room.jsonl`;
  try {
    if (!existsSync(log) && existsSync(`${dir}/artifacts.json`)) throw new Error("run has artifacts but no room log");
    if (existsSync(log)) {
      for (const line of readFileSync(log, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (!entry || typeof entry.run !== "string" || !["message", "event"].includes(entry.type)) throw new Error("malformed room record");
        if (entry.run !== run || entry.type !== "event" || entry.kind !== "member_joined") continue;
        if (typeof entry.member !== "string" || !entry.member) throw new Error("join record has no name");
        names.add(entry.member);
      }
    }
    // Startup can leave a brief before the worker ever joins; that folder must not be reused either.
    if (existsSync(`${dir}/children`)) for (const name of readdirSync(`${dir}/children`)) names.add(name);
  } catch (e) { throw new Error(`Cannot establish name history for ${run}: ${(e as Error).message}`); }
  return [...names];
}
