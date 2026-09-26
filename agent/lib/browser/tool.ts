import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runBrowser } from "./session.ts";

export function registerBrowserTool(pi: ExtensionAPI) {
  const sessions = new Set<string>();
  const worker = process.env.PI_CREW_NAME;
  let owner: string;
  pi.registerTool({
    name: "browser",
    label: "Browser",
    description: "Drive visible Chrome for Testing through shared identity leases. Open a snake_case task session with an optional registered identity (aws-staging, acme-staging, github, scratch). Reuse the session; close to hand over its profile. Typing on auth surfaces is blocked; humans perform login. Raw evidence stays private. No cookie import/export or arbitrary scripts.",
    parameters: Type.Object({
      session: Type.String(),
      command: Type.String({ description: "open, close, goto, snapshot, fill, click, press, screenshot, console, requests, tab-list, or help" }),
      args: Type.Optional(Type.Array(Type.String())),
      identity: Type.Optional(Type.String({ description: "Registered identity; open only. Omit to infer from the URL." })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      owner = worker ? `crew:${process.env.PI_CREW_RUN}:${worker}` : `main:${ctx.sessionManager.getSessionId()}`;
      const text = await runBrowser(params, { owner, signal });
      if (params.command === "open") sessions.add(params.session);
      if (params.command === "close") sessions.delete(params.session);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
  pi.on("session_shutdown", async () => {
    if (!worker) return;
    for (const session of sessions) {
      try { await runBrowser({ session, command: "close" }, { owner }); }
      catch (error) { console.error(`Browser ${session} retained its lease: ${String(error)}`); }
    }
  });
}
