import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface RecoveredPath { path: string; success: boolean; command?: string; }
export interface Recovery {
  name: string;
  run: string;
  sessionFile: string;
  span: string;
  lastAssistantText: string;
  paths: RecoveredPath[];
  tools: number;
  malformed: number;
}

function bashOutputPaths(command: string): string[] {
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|>>|>|[;&|]|[^\s><;&|]+/g) ?? [];
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== ">" && tokens[i] !== ">>" && tokens[i] !== "tee") continue;
    if (tokens[i] === "tee" && tokens[i + 1] === "-a") i++;
    const next = tokens[i + 1];
    if (!next || /^(?:[;&|><]|-)/.test(next)) continue;
    paths.push(/^["']/.test(next) ? next.slice(1, -1) : next);
  }
  return [...new Set(paths)];
}

export function recoverWorker(runsDir: string, name: string, all = false): Recovery[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error("invalid worker name");
  const runs = existsSync(runsDir) ? readdirSync(runsDir, { withFileTypes: true })
    .filter((r) => r.isDirectory() && existsSync(join(runsDir, r.name, "children", name, "sessions")))
    .map((r) => r.name).sort() : [];
  if (!runs.length) throw new Error(`no saved sessions for ${name}`);
  if (runs.length > 1) throw new Error(`ambiguous worker ${name}: ${runs.join(", ")}`);
  const dir = join(runsDir, runs[0], "children", name, "sessions");
  const sessions = readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith(".jsonl")).map((f) => f.name).sort();
  return (all ? sessions : sessions.slice(-1)).map((file) => {
    const recovered: Recovery = { name, run: runs[0], sessionFile: file, span: "unknown span", lastAssistantText: "", paths: [], tools: 0, malformed: 0 };
    const writes = new Map<string, RecoveredPath[]>();
    let first: string | undefined, last: string | undefined;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { recovered.malformed++; continue; }
      if (typeof entry?.timestamp === "string") { first ??= entry.timestamp; last = entry.timestamp; }
      if (entry?.type !== "message") continue;
      const message = entry.message;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        const text = message.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
        if (text.trim()) recovered.lastAssistantText = text.slice(0, 2000);
        for (const c of message.content) {
          if (c?.type !== "toolCall") continue;
          recovered.tools++;
          const command = c.name === "bash" && typeof c.arguments?.command === "string" ? c.arguments.command : undefined;
          const paths = command !== undefined ? bashOutputPaths(command) : (c.name === "write" || c.name === "edit") && typeof c.arguments?.path === "string" ? [c.arguments.path] : [];
          const entries = paths.map((path) => ({ path, success: false, ...(command !== undefined ? { command } : {}) }));
          recovered.paths.push(...entries);
          if (typeof c.id === "string") writes.set(c.id, entries);
        }
      } else if (message?.role === "toolResult") {
        for (const path of writes.get(message.toolCallId) ?? []) path.success = message.isError === false;
        writes.delete(message.toolCallId);
      }
    }
    if (first) recovered.span = `${first} → ${last}`;
    return recovered;
  });
}
