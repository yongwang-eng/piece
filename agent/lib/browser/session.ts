import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { ProfilePool, BROWSER_PROFILES_ROOT, inferProfile, isAlive, type Lease } from './pool.ts';
import { authTypingRule, rememberUrl } from './safety.ts';

export interface BrowserRequest { session: string; command: string; args?: string[]; identity?: string }
export interface BrowserOptions {
  owner?: string;
  runtimeRoot?: string;
  pool?: ProfilePool;
  invoke?: (args: string[], cwd: string) => Promise<string>;
  signal?: AbortSignal;
}
interface SessionState { owner: string; identity: string; lease: Lease; pid: number; closed: boolean }

const exec = promisify(execFile);
const agent = join(homedir(), '.pi/agent');
const cli = join(agent, 'lib/browser/cli.mjs');
export const COMMANDS = new Set('open close goto type click dblclick fill drag hover select check uncheck snapshot find press keydown keyup mousemove mousedown mouseup mousewheel screenshot tab-list tab-new tab-close tab-select resize go-back go-forward reload console requests dialog-dismiss help'.split(' '));
const typing = new Set(['type', 'fill', 'press', 'keydown', 'keyup', 'select']);

export function validateRequest({ session, command, args = [], identity }: BrowserRequest) {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(session)) throw new Error('Use a snake_case task session name');
  if (!COMMANDS.has(command)) throw new Error(`Unsupported browser command: ${command}`);
  if (!args.every(a => typeof a === 'string' && !a.startsWith('-'))) throw new Error('CLI overrides are disabled');
  if (identity && command !== 'open') throw new Error('Choose identity only on open');
  if (command === 'screenshot' && (args.length > 1 || args.some(a => !/^[a-zA-Z0-9_.-]+\.png$/.test(a) || a.startsWith('.')))) throw new Error('Screenshots need a bare PNG filename');
  if (['open', 'goto', 'tab-new'].includes(command) && args.length && !/^https?:\/\//.test(args[0])) throw new Error('Only HTTP(S) navigation is supported');
}

function snapshotText(output: string, cwd: string) {
  const inline = /^```yaml\r?\n([\s\S]*?)\r?\n```/m.exec(output);
  if (inline) return inline[1]!;
  const match = /\[Snapshot\]\(([^)]+)\)/.exec(output);
  if (!match) throw new Error('Browser snapshot is missing; refusing to type without fresh page evidence');
  const path = resolve(cwd, match[1]);
  const rel = relative(cwd, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('Snapshot escaped the private evidence directory');
  return readFileSync(path, 'utf8');
}

export function guardTyping(command: string, args: string[], output: string, snapshot: string) {
  if (!typing.has(command)) return;
  const url = rememberUrl(output);
  if (!url) throw new Error('Browser URL is unknown; refusing to type');
  const ref = ['fill', 'select'].includes(command) ? args[0] : undefined;
  const field = ref ? snapshot.split('\n').find(line => line.includes(`[ref=${ref}]`)) : snapshot;
  if (!field) throw new Error('Target is absent from the fresh snapshot; inspect before typing');
  const block = authTypingRule(url, 'browser_type', JSON.stringify({ args, field }));
  if (block) throw new Error(block.reason);
}

export async function runBrowser(request: BrowserRequest, options: BrowserOptions = {}) {
  validateRequest(request);
  const { session, command, args = [], identity } = request;
  const owner = options.owner ?? (process.env.PI_CREW_NAME ? `crew:${process.env.PI_CREW_RUN}:${process.env.PI_CREW_NAME}` : 'main:');
  if (owner === 'main:') throw new Error('Browser owner is missing; use the browser tool in pi');
  const ownerKey = createHash('sha256').update(owner).digest('hex').slice(0, 20);
  const cwd = join(options.runtimeRoot ?? join(agent, 'workers/browser_cli'), ownerKey, session);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  // CLI daemon names are scoped by the nearest .playwright marker, not by cwd alone.
  mkdirSync(join(cwd, '.playwright'), { recursive: true, mode: 0o700 });
  const pool = options.pool ?? new ProfilePool(BROWSER_PROFILES_ROOT);
  const mutex = join(cwd, 'command.lock');
  try { writeFileSync(mutex, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error(`Browser session has a command in flight: ${cwd}. Do not overlap commands; inspect a stale owner before cleanup.`); }
  const statePath = join(cwd, 'session.json');
  const runner = options.invoke ?? (async (argv: string[]) => {
    const result = await exec(process.execPath, [cli, `-s=${session}`, ...argv], { cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, signal: options.signal });
    if (/^### Error/m.test(result.stdout)) throw new Error(result.stdout);
    return result.stdout;
  });
  const invoke = (argv: string[]) => runner(argv, cwd);
  const save = (state: SessionState) => { writeFileSync(statePath + '.tmp', JSON.stringify(state), { mode: 0o600 }); renameSync(statePath + '.tmp', statePath); };
  try {
    let state: SessionState | undefined = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : undefined;
    if (state && state.owner !== owner) throw new Error('Browser session belongs to a different owner');
    if (command === 'help') return await invoke(['--help', ...args]);
    if (command === 'open' && (!state || state.closed || !isAlive(state.pid))) {
      const spec = inferProfile(args.join(' '), identity ? [identity] : state ? [state.identity] : undefined);
      const lease = pool.lease(spec, owner, session);
      state = { owner, identity: spec.name, lease, pid: process.pid, closed: false };
      save(state);
      try {
        const result = await invoke(['open', ...args, '--headed', '--config', join(agent, 'config/browser.json'), '--profile', lease.dir]);
        const pid = Number(/opened with pid (\d+)/.exec(result)?.[1]);
        pool.adopt(lease, pid);
        state.pid = pid;
        save(state);
        return `Identity: ${lease.profile}\nEvidence: ${cwd}\n${result}`;
      } catch (error) {
        if (!pool.browserAlive(lease.profile)) { pool.release(lease); state.closed = true; save(state); }
        throw error;
      }
    }
    if (!state || state.closed) throw new Error('Open this task session first');
    const lock = pool.readLock(state.lease.profile);
    if (!lock || lock.token !== state.lease.token || lock.run !== owner || lock.child !== session) throw new Error('Browser lease changed; refusing stale task control');
    if (identity && inferProfile('', [identity]).name !== state.identity) throw new Error('Close this session before choosing another identity');
    if (command === 'close') {
      const result = await invoke(['close']);
      pool.release(state.lease, state.pid);
      state.closed = true;
      save(state);
      return result;
    }
    if (!isAlive(state.pid)) throw new Error('Browser daemon exited; close/reopen this session after inspecting its profile');
    if (typing.has(command)) {
      const observation = await invoke(['snapshot']);
      guardTyping(command, args, observation, snapshotText(observation, cwd));
    }
    if (command === 'screenshot' && args.length) return await invoke(['screenshot', '--filename', args[0]!]);
    return await invoke(command === 'open' ? args.length ? ['goto', ...args] : ['snapshot'] : [command, ...args]);
  } finally { unlinkSync(mutex); }
}
