// Runs the inline press-test: `pi -p` with ONLY the press extension loaded; reads the verdict file. ~30-60 s (one real model turn).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
const OUT = "/tmp/inline-press.json"; rmSync(OUT, { force: true });
const ext = `${homedir()}/.pi/agent/lib/room/testing/inline.press.ext.ts`;
const intercom = `${homedir()}/.pi/agent/git/github.com/nicobailon/pi-intercom/index.ts`;
const t0 = Date.now();
const child = spawn("pi", ["--no-session", "--no-context-files", "--no-skills", "--no-extensions", "-e", intercom, "-e", ext, "-p", "say ok"], { cwd: "/tmp", env: { ...process.env, PRESS_OUT: OUT, TMUX_PANE: "" }, stdio: ["ignore", "pipe", "pipe"] });
let err = ""; child.stderr.on("data", (d) => (err += d)); let out = ""; child.stdout.on("data", (d) => (out += d));
const killer = setTimeout(() => { child.kill("SIGKILL"); }, 120_000);
child.on("exit", (code) => {
  clearTimeout(killer);
  const ms = Date.now() - t0;
  if (!existsSync(OUT)) { console.log(`FAIL · no verdict file · exit ${code} · ${ms}ms\n--- stderr tail:\n${err.slice(-1500)}\n--- stdout tail:\n${out.slice(-600)}`); process.exit(1); }
  const r = JSON.parse(readFileSync(OUT, "utf8"));
  console.log(`${r.ok ? "PASS" : "FAIL"} · ${ms}ms · ${r.why ?? ""}`);
  for (const [k, v] of Object.entries(r.steps)) console.log(`  ${k}: ${JSON.stringify(v)}`);
  if (!r.ok) console.log(`--- stderr tail:\n${err.slice(-800)}`);
  process.exit(r.ok ? 0 : 1);
});
