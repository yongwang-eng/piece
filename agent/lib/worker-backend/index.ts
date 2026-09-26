/**
 * The shared vocabulary for worker backends. Types only — no runtime, no pi imports.
 *
 * Two backends exist, and the difference is deliberate:
 *
 *   fleet  in-process `AgentSession` children  — cheap, batchable, headless, code-guarded tool scope
 *   crew   a stock `pi` process per tmux pane  — typable by the human, full TUI, survives /reload
 *
 * Both answer the same questions ("who exists, what is it doing, tell it this, stop it"), so the
 * verbs live here once. The eventual router (a model judgment: is this work worth a dedicated
 * process the human can sit with, or a background lane?) selects a backend behind this interface;
 * nothing above it should care which one it got.
 *
 * Deliberately NOT here: adapters. Crew conforms structurally today; a fleet adapter is written
 * when there is a second real caller, not before (abstractions are earned).
 */

export interface Brief {
  /** What outcome the worker owes. The single most load-bearing field. */
  goal: string;
  /** How the worker knows it is finished — stated in the *project's* terms, never main's paraphrase. */
  doneWhen: string;
  /** What main already established, so the worker does not re-derive it. */
  alreadyKnown?: string;
  /** Judgment calls the worker should escalate instead of guessing. */
  askParentIf?: string;
  /** Tools the worker actually has — main cannot see them, so it must be told. */
  tools?: string;
  budgetMinutes?: number;
  /** Progress verbosity for THIS task, not a property of the worker. */
  reportingMode?: ReportingMode;
}

export type ReportingMode = "quiet" | "collaborative";

export interface WorkerSpec {
  name: string;
  run: string;
  brief: Brief;
  /** Named capability/persona bundle: `~/.pi/agent/profiles/<profile>/AGENTS.md` (+ backend guards). */
  profile?: string;
  model?: string;
  cwd?: string;
  /** implementer-style backends only: the one tree the worker may modify. */
  worktree?: string;
}

export type BackendKind = "fleet" | "crew";

/**
 * `starting` spawned, not yet reachable · `idle` reachable, no turn · `working` model turn in flight ·
 * `stalled` a turn that has produced nothing for long enough to be suspicious (surfaced, never guessed at) ·
 * `blocked` waiting on an answer (consult/permission) · `reported` delivered a result and still live ·
 * `failed` its turn ended in error/abort · `gone` unreachable while still expected · `disposed` lifetime over.
 */
export type WorkerStatus = "starting" | "idle" | "working" | "stalled" | "blocked" | "reported" | "failed" | "gone" | "disposed";

/** A live worker is never auto-hidden: `reported` and `idle` still exist until explicitly disposed. */
export const LIVE_STATUSES: readonly WorkerStatus[] = ["starting", "idle", "working", "stalled", "blocked", "reported"];

export interface WorkerHandle {
  /** Stable `#N` across both backends (see ../agent-ui/ids.ts) — never a row index. */
  id?: number;
  name: string;
  run: string;
  backend: BackendKind;
  /** Where to reach it: an intercom session id/name (crew) or an internal session key (fleet). */
  address?: string;
  /** Where the human can watch it, when that exists: a tmux pane id. */
  pane?: string;
  spawnedAt: string;
}

export type WorkerEventKind = "started" | "progress" | "consult" | "report" | "failed" | "stalled" | "unstalled" | "disposed";

export interface WorkerEvent {
  kind: WorkerEventKind;
  worker: string;
  run: string;
  at: string;
  /** Who caused this transition — the record must say, even when another session did it. */
  actor: "main" | "governor" | "worker" | "human" | "other-session" | "shutdown";
  text?: string;
  details?: Record<string, unknown>;
}

export interface WorkerBackend {
  readonly kind: BackendKind;
  /** True when this backend can run at all right now (crew needs tmux + intercom). */
  available(): boolean;

  spawn(spec: WorkerSpec): Promise<WorkerHandle>;
  /** A new task: starts a turn when idle, queues behind the current one when busy. */
  send(worker: string, text: string): Promise<void>;
  /** A mid-turn redirect: delivered at the worker's next tool boundary; the turn continues. */
  steer(worker: string, text: string): Promise<void>;
  /** Resolve one outstanding consult by id — correlated, so a stray "yes" can never answer it. */
  answer?(worker: string, consultId: string, text: string): Promise<void>;
  /** Ask and wait (bounded). Optional: not every backend can block safely. */
  ask?(worker: string, question: string): Promise<string>;
  /** Cooperative: stop at the next safe boundary and hand context back. Never fabricates a result. */
  recall?(worker: string, reason: string): Promise<void>;
  /** Hard stop. Always available, always logged with an actor. */
  kill(worker: string, reason: string): Promise<void>;

  list(): WorkerHandle[];
  status(worker: string): WorkerStatus;
  on(listener: (event: WorkerEvent) => void): () => void;
}
