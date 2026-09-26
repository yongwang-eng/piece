import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerBrowserTool } from "../../lib/browser/tool.ts";

export default function browser(pi: ExtensionAPI) {
  registerBrowserTool(pi);
  pi.registerCommand("browser", {
    description: "Navigate, test, investigate, or fill forms in isolated Chrome for Testing",
    handler: async (args, ctx) => {
      if (!args.trim()) return ctx.ui.notify("Usage: /browser <url or task>", "info");
      const path = join(getAgentDir(), "skills/browser/SKILL.md");
      const skill = readFileSync(path, "utf8");
      pi.sendUserMessage(`Follow the browser skill at ${path}:\n\n${skill}\n\nUser task: ${args.trim()}`, { deliverAs: "followUp" });
    },
  });
}
