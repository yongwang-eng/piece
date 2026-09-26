/**
 * Role guards — the structural refusals a role carries, enforced on pi's `tool_call`, not asked of the model.
 *
 * Shape: each role folder may hold `profiles/<role>/guard.ts` exporting `rules: RoleRules`; this module holds only what
 * several roles share (the Block type, auth regexes, the review slot) and the loader the worker calls. No role names here:
 * adding a role = adding a folder (same lookup as AGENTS.md/CREW.md). Pure decisions (string in → block-or-undefined out)
 * so every rule runs under node --test.
 */
export type Block = { block: true; reason: string } | undefined;

/** The detached review checkout. No worker may operate there; the implementer may not even be pointed at it. */
export const REVIEW_SLOT = "/Users/me/Code/acme/app";

export const AUTH_HOSTS = /(okta\.com|signin\.aws\.amazon\.com|accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|:\/\/(signin|login|auth|sso|id)\.|\/login\b|\/signin\b|\/sso\b|\/oauth)/i;
export const AUTH_FIELD = /(password|passcode|otp|one-time|verification code|mfa|totp)/i;

export interface RoleRules {
  /** every `bash` call: the command string */
  bash?: (cmd: string, ctx: GuardContext) => Block;
  /** every `edit`/`write`: the target path */
  write?: (tool: string, path: string | undefined, ctx: GuardContext) => Block;
  /** any other tool (Playwright MCP etc.): tool name + JSON args; `ctx.lastUrl` is the last page URL the guard saw */
  tool?: (toolName: string, argsJson: string, ctx: GuardContext) => Block;
  /** observe results (e.g. to track the browser's current URL); never blocks */
  observeResult?: (toolName: string, resultText: string, ctx: GuardContext) => void;
}

export interface GuardContext {
  /** the worker's cwd — the implementer's worktree */
  worktree: string;
  /** the worker's vault artifact folder (deliverable.md, decisions.md, evidence/) — ALWAYS writable, whatever the role's rule says */
  artifactsDir?: string;
  /** mutable scratch the rules may keep (browser: last page URL). The shim also writes `approvedAction` = the verb+target of
   *  the most recent consult a HUMAN approved, so a rule can admit exactly that act once (D40: approval is bound to the ask). */
  state: Record<string, string>;
}

/** Load `profiles/<role>/guard.ts` if it exists. A role with no guard file has no structural refusals beyond the global law. */
export async function loadRoleGuard(agentDir: string, role: string | undefined, exists: (p: string) => boolean): Promise<RoleRules | undefined> {
  if (!role) return undefined;
  const f = `${agentDir}/profiles/${role}/guard.ts`;
  if (!exists(f)) return undefined;
  const mod = await import(f);
  return mod.rules as RoleRules;
}

/** Wire a role's rules onto a pi-like `on("tool_call")`. Returns nothing; the block flows back as pi's tool_call result. */
export function applyRoleRules(ext: { on: (event: string, fn: (ev: any) => any) => void }, rules: RoleRules, ctx: GuardContext) {
  ext.on("tool_call", (ev: any) => {
    const tool = String(ev.toolName ?? "");
    if (tool === "bash" && rules.bash) return rules.bash(String(ev.input?.command ?? ""), ctx);
    if ((tool === "edit" || tool === "write") && rules.write) {
      const path = String(ev.input?.path ?? ev.input?.file_path ?? "");
      if (ctx.artifactsDir && (path === ctx.artifactsDir || path.startsWith(ctx.artifactsDir.replace(/\/$/, "") + "/"))) return undefined;   // its own artifacts are never out of bounds
      return rules.write(tool, path || undefined, ctx);
    }
    if (rules.tool) return rules.tool(tool, JSON.stringify(ev.input ?? {}), ctx);
    return undefined;
  });
  if (rules.observeResult) ext.on("tool_result", (ev: any) => { try { rules.observeResult!(String(ev.toolName ?? ""), typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result ?? ""), ctx); } catch { /* observe never throws */ } });
}
