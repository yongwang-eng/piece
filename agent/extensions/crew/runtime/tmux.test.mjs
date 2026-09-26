import { test } from "node:test";
import assert from "node:assert/strict";
import { shq, workerCommand, splitFirstArgs, splitNextArgs, equalizeArgs, killArgs, isPaneId, parseSpawn, workerExtensions, slugName, uniqueName, focusMovingVerb, presetFiles, presetReads } from "./tmux.ts";

const spec = {
  name: "w1", run: "crew-x", cwd: "/tmp/a b", profile: "reviewer", model: "openai/gpt",
  agentDir: "/A", constitutionPath: "/A/workers/constitution.md", briefPath: "/A/workers/runs/crew-x/children/w1/brief.md", sessionDir: "/A/workers/runs/crew-x/children/w1/sessions",
};

test("shq escapes single quotes", () => {
  assert.equal(shq("it's"), `'it'\\''s'`);
});

test("worker command: curated extensions, no discovery, brief via file, env set", () => {
  const c = workerCommand(spec);
  assert.match(c, /^cd '\/tmp\/a b' && PI_CREW_ROLE=worker PI_CREW_NAME='w1' PI_CREW_RUN='crew-x' PI_CREW_BRIEF=/);
  assert.ok(!c.includes("intercom"), "workers do not load pi-intercom: the room is the only transport");
  assert.ok(c.includes("PI_CREW_ROLE_LINE='reviewer'"), "role defaults to the profile name");
  assert.ok(!c.includes("compact-footer"), "worker.ts owns the footer");
  assert.match(c, /--no-extensions --no-skills --no-context-files --no-prompt-templates --no-themes --no-approve/);
  for (const e of workerExtensions("/A")) assert.ok(c.includes(`-e '${e}'`), e);
  assert.ok(!c.includes("fleet/index.ts") && !c.includes("main-guard"), "fleet/main-guard never load in a worker");
  assert.ok(c.includes(`--append-system-prompt '/A/workers/constitution.md'`), "every worker gets the standing rules");
  assert.ok(c.indexOf("--append-system-prompt '/A/workers/constitution.md'") < c.indexOf("--append-system-prompt '/A/workers/runs"), "constitution comes before the brief");
  assert.ok(!c.includes(`profiles/reviewer/AGENTS.md`), "the profile is NOT derived here any more — presets arrive via presetFiles (spawn resolves them)");
  assert.ok(c.includes(`--append-system-prompt '${spec.briefPath}'`));
  assert.ok(c.includes(`--session-dir '${spec.sessionDir}'`));
  assert.ok(c.includes(`--model 'openai/gpt'`));
  assert.ok(!c.includes("--tools"));
  assert.match(c, /; read$/);
});

test("worker command without profile/model omits those flags but never the constitution", () => {
  const c = workerCommand({ ...spec, profile: undefined, model: undefined, tools: "read,bash" });
  assert.ok(!c.includes("/profiles/"));
  assert.ok(c.includes(`--append-system-prompt '/A/workers/constitution.md'`), "a no-profile worker still gets the standing rules");
  assert.ok(!c.includes("--model"));
  assert.ok(c.includes("--tools 'read,bash'"));
});

test("split argv addresses panes by id and keeps main focus (-d)", () => {
  const a = splitFirstArgs("%28", "cmd");
  assert.deepEqual(a.slice(0, 5), ["split-window", "-h", "-d", "-p", "40"]);
  assert.ok(a.includes("-P") && a.includes("#{pane_id}") && a.includes("%28") && a.at(-1) === "cmd");
  const b = splitNextArgs("%176", "cmd");
  assert.deepEqual(b.slice(0, 3), ["split-window", "-v", "-d"]);
  assert.ok(b.includes("%176"));
});

test("equalize = main-vertical + main width 60%, floor 40", () => {
  const [layout, resize] = equalizeArgs("%28", 181);
  assert.deepEqual(layout, ["select-layout", "-t", "%28", "main-vertical"]);
  assert.deepEqual(resize, ["resize-pane", "-t", "%28", "-x", "109"]);
  assert.equal(equalizeArgs("%1", 50)[1].at(-1), "40");
});

test("kill + pane id validation", () => {
  assert.deepEqual(killArgs("%5"), ["kill-pane", "-t", "%5"]);
  assert.ok(isPaneId("%12") && !isPaneId("12") && !isPaneId("%x"));
});

test("one name per worker: slugName + uniqueName (reviewer, reviewer-2, …)", () => {
  assert.equal(slugName("doc owner"), "doc-owner");
  assert.equal(slugName("Test-Suite Auditor!"), "test-suite-auditor");
  assert.equal(slugName("   "), "worker");
  assert.equal(uniqueName("reviewer", []), "reviewer");
  assert.equal(uniqueName("reviewer", ["reviewer"]), "reviewer-2");
  assert.equal(uniqueName("reviewer", ["reviewer", "reviewer-2", "main"]), "reviewer-3");
});

test("parseSpawn", () => {
  assert.deepEqual(parseSpawn("w1 --profile reviewer --model m -- review PR 1".split(" ")), { name: "w1", profile: "reviewer", model: "m", task: "review PR 1" });
  assert.deepEqual(parseSpawn(["w2", "--", "do", "x"]), { name: "w2", task: "do x" });
  assert.deepEqual(parseSpawn(["w3", "--cwd", "~/Code/x", "--", "t"]), { name: "w3", cwd: "~/Code/x", task: "t" });
  assert.deepEqual(parseSpawn(["w4", "--role", "test-suite", "auditor", "--profile", "reviewer", "--", "t"]), { name: "w4", role: "test-suite auditor", profile: "reviewer", task: "t" });
  // an --intake whose TEXT contains a --word (a test command) must not end the flag: only KNOWN flags do
  const it = parseSpawn(["--role", "historian", "--intake", "run", "node", "--test", "lib/**", "then", "--cwd", "/x", "--", "t"]);
  assert.equal(it.intake, "run node --test lib/** then", "unknown --word inside intake text is text"); assert.equal(it.cwd, "/x");
  assert.ok("error" in parseSpawn(["w1"]));
  // name is optional: the role (or profile) names the worker
  assert.deepEqual(parseSpawn(["--role", "doc", "owner", "--", "t"]), { role: "doc owner", task: "t" });
  assert.deepEqual(parseSpawn(["--profile", "x", "--", "t"]), { profile: "x", task: "t" });
  assert.ok("error" in parseSpawn(["--model", "m", "--", "t"]), "no name, no role, no profile → nothing to call it");
  assert.ok("error" in parseSpawn(["w1", "--bogus", "v", "--", "t"]));
  assert.ok("error" in parseSpawn(["bad name!", "--", "t"]));
});

test("INVARIANT — crew never moves focus: every argv crew builds passes the guard; every select-* form is refused", () => {
  for (const argv of [splitFirstArgs("%1", "cmd"), splitNextArgs("%1", "cmd"), ...equalizeArgs("%1", 120), killArgs("%2"),
                      ["set-option", "-p", "-t", "%2", "pane-border-style", "fg=red"], ["display", "-p", "-t", "%2", "#{pane_pid}"], ["send-keys", "-t", "%2", "Escape"]]) {
    assert.equal(focusMovingVerb(argv), undefined, `must be allowed: tmux ${argv.join(" ")}`);
  }
  assert.equal(focusMovingVerb(["select-pane", "-t", "%2", "-P", "fg=red"]), "select-pane", "-P looks like a style setter but SELECTS");
  assert.equal(focusMovingVerb(["select-pane", "-t", "%2", "-T", "title"]), "select-pane");
  assert.equal(focusMovingVerb(["select-window", "-t", "1"]), "select-window");
  assert.equal(focusMovingVerb(["split-window", "-h", "-t", "%1", "cmd"]), "split-window (without -d)");
  assert.equal(focusMovingVerb(["switch-client", "-t", "x"]), "switch-client");
});

test("presets: --role <x> resolves to profiles/<slug>/{AGENTS,CREW}.md when present, in that order; unknown role = ad-hoc (no files)", () => {
  const have = new Set(["/a/profiles/reviewer/AGENTS.md", "/a/profiles/reviewer/CREW.md", "/a/profiles/historian/AGENTS.md"]);
  const ex = (p) => have.has(p);
  assert.deepEqual(presetFiles("/a", "reviewer", ex), ["/a/profiles/reviewer/AGENTS.md", "/a/profiles/reviewer/CREW.md"]);
  assert.deepEqual(presetFiles("/a", "Doc Owner", ex), [], "ad-hoc role → nothing appended, the brief carries it");
  assert.deepEqual(presetFiles("/a", "historian", ex), ["/a/profiles/historian/AGENTS.md"], "CREW.md optional");
  assert.deepEqual(presetFiles("/a", undefined, ex), []);
  const cmd = workerCommand({ name: "r", run: "x", cwd: "/tmp", mainIntercomId: "m", agentDir: "/a", intercomEntry: "/i.ts", briefPath: "/b.md", sessionDir: "/s", constitutionPath: "/c.md", presetFiles: ["/a/profiles/reviewer/AGENTS.md", "/a/profiles/reviewer/CREW.md"] });
  const order = ["--append-system-prompt '/c.md'", "--append-system-prompt '/a/profiles/reviewer/AGENTS.md'", "--append-system-prompt '/a/profiles/reviewer/CREW.md'", "--append-system-prompt '/b.md'"].map((f) => cmd.indexOf(f));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `constitution → craft → room layer → brief: ${cmd}`);
});

test("presetReads: `reads:` in CREW.md → claude_context paths (bare names get the folder + .md; absolute kept); absent → []", () => {
  const md = "# reviewer\n\nreads: pr_conventions, ci_source_map.md, /abs/x.md\n\n## Room\n";
  assert.deepEqual(presetReads(md, "/V"), ["/V/resources/claude_context/pr_conventions.md", "/V/resources/claude_context/ci_source_map.md", "/abs/x.md"]);
  assert.deepEqual(presetReads("# critic\n## Room\n", "/V"), []);
});

test("MCP is opt-in per worker: absent by default, adapter only when a server is granted, crew wrapper for browser", () => {
  const A = "/agent";
  const base = workerExtensions(A);
  assert.ok(!base.some((e) => /mcp/.test(e)), "a worker gets no MCP unless it asks — MCP is a capability, not a default");

  const granted = workerExtensions(A, undefined, ["notion"]);
  assert.deepEqual(granted.slice(0, base.length), base, "opting in ADDS, never reorders or drops the curated list");
  assert.equal(granted.at(-1), "/agent/npm/node_modules/pi-mcp-adapter/index.ts", "a granted server loads the adapter; --tools decides what is callable");
  assert.deepEqual(workerExtensions(A, undefined, []), base, "an empty grant loads nothing");

  const br = workerExtensions(A, "browser");
  assert.equal(br.at(-1), "/agent/extensions/crew/runtime/browser.ts", "browser workers use the shared CLI tool, not an MCP adapter");
  assert.ok(!br.includes("/agent/npm/node_modules/pi-mcp-adapter/index.ts"), "exactly one adapter, never both");

  assert.ok(!base.some((e) => /ask-user/.test(e)), "control: the ask-user removal still holds");
});

test("a full-width base keeps room for its uniqueness suffix", async () => {
  const { Worker } = await import("node:worker_threads");
  const url = new URL("./tmux.ts", import.meta.url).href;
  const name = "x".repeat(32);
  const outcome = await new Promise((resolve, reject) => {
    const worker = new Worker(`const {parentPort}=require('node:worker_threads'); import(${JSON.stringify(url)}).then(m=>parentPort.postMessage(m.uniqueName(${JSON.stringify(name)},[${JSON.stringify(name)}])));`, { eval: true });
    const timer = setTimeout(() => { void worker.terminate().then(() => resolve("timed out")); }, 1000);
    worker.once("message", value => { clearTimeout(timer); void worker.terminate(); resolve(value); });
    worker.once("error", error => { clearTimeout(timer); void worker.terminate(); reject(error); });
  });
  assert.equal(outcome, `${"x".repeat(30)}-2`);
});


test("workerCommand: an MCP grant registers its tools DIRECTLY (MCP_DIRECT_TOOLS), or the allowlisted names point at nothing", () => {
  const c = workerCommand({ name: "telemetry", run: "x", cwd: "/tmp", agentDir: "/a", briefPath: "/b.md", sessionDir: "/s", constitutionPath: "/c.md",
    tools: "read,bash,hubmcp_whoami,hubmcp_search_datadog_logs,slack_read_channel", mcpServers: ["hubmcp", "slack"] });
  assert.match(c, /MCP_DIRECT_TOOLS='hubmcp\/whoami,hubmcp\/search_datadog_logs,slack\/read_channel'/);
  const none = workerCommand({ name: "code", run: "x", cwd: "/tmp", agentDir: "/a", briefPath: "/b.md", sessionDir: "/s", constitutionPath: "/c.md", tools: "read,bash" });
  assert.doesNotMatch(none, /MCP_DIRECT_TOOLS/);
});
