// browser: structural auth interception — typing into a login surface is blocked; the worker must consult(auth) and wait for a HUMAN.
import type { RoleRules } from "../../lib/guards/index.ts";
import { authTypingRule, rememberUrl } from "../../lib/browser/safety.ts";
export { authTypingRule, rememberUrl };

export const rules: RoleRules = {
  tool: (tool, argsJson, ctx) => authTypingRule(ctx.state.lastUrl ?? "", tool, argsJson),
  observeResult: (_tool, text, ctx) => { const u = rememberUrl(text); if (u) ctx.state.lastUrl = u; },
};
