// Usage: node ~/.pi/agent/scripts/mcp-exclude-check.mjs — runs pi-mcp-adapter's own isToolAllowed over ~/.agents/mcp.json vs the cached Slack catalog. Edit server name to test others.
import { isToolAllowed } from "../npm/node_modules/pi-mcp-adapter/dist/types.js";
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(process.env.HOME + "/.agents/mcp.json", "utf8"));
const def = cfg.mcpServers.slack;
const cache = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/mcp-cache.json", "utf8"));
const tools = cache.servers.slack.tools.map(t => t.name);
for (const prefix of ["server", "short", "none"]) {
  const kept = tools.filter(t => isToolAllowed(t, "slack", prefix, def.includeTools, def.excludeTools));
  console.log(prefix, kept.length, "kept; excluded:", tools.filter(t => !kept.includes(t)).join(", "));
}
