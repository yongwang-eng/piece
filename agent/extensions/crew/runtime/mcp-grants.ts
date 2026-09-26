/**
 * Least-privilege MCP grants for workers (roadmap §8, D79). Pure: no pi imports.
 *
 * `config/mcp_tools.json` lists READ tools per server; everything else is a write and is never granted. The grammar has one
 * spawn-time token, `<server>:read` — there is deliberately no spelling for "the whole server" or for a write bundle.
 */
import { readFileSync } from "node:fs";

export type McpInventory = Record<string, { read: string[] }>;

/** Missing or malformed ⇒ {} ⇒ every grant is refused. Fails closed; never widens. */
export function loadMcpInventory(path: string): McpInventory {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const servers = raw?.servers;
    if (!servers || typeof servers !== "object") return {};
    const out: McpInventory = {};
    for (const [server, v] of Object.entries<any>(servers)) {
      if (Array.isArray(v?.read)) out[server] = { read: v.read.filter((t: unknown) => typeof t === "string") };
    }
    return out;
  } catch {
    return {};
  }
}

/** `mcp`, `mcpScript`, `mcp__<server>`: each dispatches to ANY tool on a connected server, so granting one grants every write. */
export function isGateway(name: string): boolean {
  return name === "mcp" || name === "mcpScript" || name.startsWith("mcp__");
}

/** The adapter's default prefix mode is `server`: `<server>_<tool>` with `.` → `_` in the tool name. */
const prefixed = (server: string, tool: string) => `${server}_${tool.replace(/\./g, "_")}`;

export function grantsFor(needs: string[], inv: McpInventory): { tools: string[]; servers: string[] } {
  const tools: string[] = [], servers: string[] = [];
  for (const need of needs) {
    const parts = need.split(":");
    if (parts.length !== 2 || parts[1] !== "read") {
      if (parts[1] === "write") throw new Error(`needs "${need}": writes are never a bundle — a worker that needs a write reports to main`);
      throw new Error(`needs "${need}": name the level — the only MCP token is "<server>:read"`);
    }
    const server = parts[0];
    const entry = inv[server];
    if (!entry) throw new Error(`needs "${need}": unknown MCP server "${server}" — add its read tools to config/mcp_tools.json first`);
    if (!servers.includes(server)) servers.push(server);
    for (const t of entry.read) {
      const name = prefixed(server, t);
      if (!tools.includes(name) && !isGateway(name)) tools.push(name);
    }
  }
  return { tools, servers };
}

/** Names in an explicit `tools` string that the list does not permit: any gateway, and any `<known server>_…` not in its read set. */
export function mcpNameViolations(tools: string[], inv: McpInventory): string[] {
  const out: string[] = [];
  for (const raw of tools) {
    const t = raw.trim();
    if (!t) continue;
    if (isGateway(t)) { out.push(t); continue; }
    for (const [server, entry] of Object.entries(inv)) {
      if (!t.startsWith(`${server}_`)) continue;
      if (!entry.read.some((r) => prefixed(server, r) === t)) out.push(t);
      break;
    }
  }
  return out;
}
