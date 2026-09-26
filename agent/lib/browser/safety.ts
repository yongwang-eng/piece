import { AUTH_FIELD, AUTH_HOSTS, type Block } from "../guards/index.ts";

/** `lastUrl` = the page URL seen in the previous Playwright result; `inner` = the tool about to run. */
export function authTypingRule(lastUrl: string, inner: string, argsJson: string): Block {
  const typing = /browser_(type|fill_form|press_key)/.test(inner);
  if (!typing) return undefined;
  if (AUTH_HOSTS.test(lastUrl) || AUTH_FIELD.test(argsJson))
    return { block: true, reason: `BLOCKED by governance: typing into an authentication surface (${lastUrl || "credential field"}). Call consult(kind="auth") and wait for a HUMAN answer.` };
  return undefined;
}

/** Playwright results carry the page URL; remember the latest so the next typing call can be judged. */
export function rememberUrl(resultText: string): string | undefined {
  const m = /Page URL:\s*(\S+)|"url"\s*:\s*"([^"]+)"|\burl=(\S+)/i.exec(resultText);
  return m?.[1] ?? m?.[2] ?? m?.[3];
}
