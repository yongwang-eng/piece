/**
 * Connection settings: `<agentDir>/config/pubsub.json` names the host/port and WHERE the credential lives —
 * never the credential itself (the config dir is tracked in git; the credential file is not).
 *
 *   { "host": "127.0.0.1", "port": 16379, "passwordEnv": "REDISCLI_AUTH", "passwordFile": "~/.config/claude/pi-pubsub.env" }
 *
 * Resolution: process env `passwordEnv` first (a shell that sourced the file), else the `passwordEnv` line of
 * `passwordFile` (`export NAME=value` or `NAME=value`) — a tmux-spawned worker has neither main's env nor a login shell.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PubSubConfig {
  host: string;
  port: number;
  password?: string;
}

interface ConfigFile {
  host?: unknown;
  port?: unknown;
  passwordEnv?: unknown;
  passwordFile?: unknown;
}

export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function loadPubSubConfig(options: { agentDir?: string; env?: NodeJS.ProcessEnv; readFile?: (path: string) => string } = {}): PubSubConfig {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const path = join(options.agentDir ?? defaultAgentDir(env), "config", "pubsub.json");
  let file: ConfigFile;
  try { file = JSON.parse(readFile(path)); } catch (e) { throw new Error(`pi-pubsub: cannot read ${path}: ${(e as Error).message}`); }
  if (typeof file !== "object" || file === null) throw new Error(`pi-pubsub: ${path} must be a JSON object`);

  const host = typeof file.host === "string" && file.host ? file.host : undefined;
  const port = typeof file.port === "number" && Number.isInteger(file.port) && file.port > 0 && file.port < 65536 ? file.port : undefined;
  if (!host) throw new Error(`pi-pubsub: ${path} needs a "host" string`);
  if (!port) throw new Error(`pi-pubsub: ${path} needs a "port" integer in 1..65535`);
  // Loopback is the contract for this machine: a config pointing anywhere else is a mistake, not a feature.
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") throw new Error(`pi-pubsub: ${path} host must be loopback, got ${host}`);

  const passwordEnv = typeof file.passwordEnv === "string" && file.passwordEnv ? file.passwordEnv : undefined;
  const passwordFile = typeof file.passwordFile === "string" && file.passwordFile ? expandHome(file.passwordFile) : undefined;
  let password: string | undefined;
  if (passwordEnv && env[passwordEnv]) password = env[passwordEnv];
  else if (passwordEnv && passwordFile) {
    let text: string;
    try { text = readFile(passwordFile); } catch (e) { throw new Error(`pi-pubsub: cannot read credential file ${passwordFile}: ${(e as Error).message}`); }
    password = readEnvLine(text, passwordEnv);
    if (!password) throw new Error(`pi-pubsub: ${passwordFile} has no ${passwordEnv}= line`);
  } else if (passwordEnv) {
    throw new Error(`pi-pubsub: ${passwordEnv} is not set and ${path} names no passwordFile`);
  }
  return password === undefined ? { host, port } : { host, port, password };
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** Value of `NAME=...` (optionally `export NAME=...`) in a dotenv-style text. Quotes around the value are stripped. */
export function readEnvLine(text: string, name: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] !== name) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v || undefined;
  }
  return undefined;
}
