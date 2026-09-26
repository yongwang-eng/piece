// Devin REST, the only path (Slack @Devin posts as Yong; Linear assign notifies). Creds are the secret-lease env vars.
const ORG = () => process.env.DEVIN_ORG_ID;
const KEY = () => process.env.DEVIN_API_KEY;

export function leased(): boolean { return !!(ORG() && KEY()); }
/** identity of the leased key, for "is this the same key Devin rejected" — compared in memory, never stored */
export const keyTag = (): string | undefined => KEY();

async function call(method: string, path: string, body?: unknown): Promise<{ code: number; data: any }> {
  if (!leased()) throw new Error("Devin creds not leased — run secret_unlock devin");
  const res = await fetch(`https://api.devin.ai/v3/organizations/${ORG()}${path}`, {
    method, headers: { authorization: `Bearer ${KEY()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data: any = text; try { data = JSON.parse(text); } catch { /* plain */ }
  return { code: res.status, data };
}

export const api = {
  create: (prompt: string, title: string) => call("POST", "/sessions", { prompt, title }),
  notes: (cursor?: string) => call("GET", `/knowledge/notes?limit=100${cursor ? `&cursor=${cursor}` : ""}`),
  session: (id: string) => call("GET", `/sessions/${id}`),
  messages: (id: string) => call("GET", `/sessions/${id}/messages?limit=100`),
  say: (id: string, message: string) => call("POST", `/sessions/${id}/messages`, { message }),
  tag: (id: string, tags: string[]) => call("POST", `/sessions/${id}/tags`, { tags }),
  archive: (id: string) => call("POST", `/sessions/${id}/archive`),
};
