import assert from "node:assert/strict";
import test from "node:test";
import { mainBashPolicy } from "./index.ts";

const allowed = (cmd) => assert.equal(mainBashPolicy({ command: cmd }).block, undefined, `expected ALLOWED on main: ${cmd}`);
const blocked = (cmd) => assert.ok(mainBashPolicy({ command: cmd }).block, `expected BLOCKED on main: ${cmd}`);

test("wait words inside quotes or heredoc bodies are not commands", () => {
  allowed('rg -n "tail -f" src');
  allowed("grep -rn 'gh run watch' docs/");
  allowed(`cat > /tmp/notes.md <<'EOF'
watch the CI tab for the red X
wait
tail -f is banned on main
sleep 300 is what we do NOT do
EOF`);
  allowed(`git log --grep "sleep 30 removed from poller"`);
  allowed("echo 'while true; do sleep 60; done' > script.sh");
});

test("control: the same words in command position are still rejected", () => {
  blocked("tail -f /tmp/run.log");
  blocked("sleep 30");
  blocked("ls; sleep 45");
  blocked("cat <<'EOF' > x\nnote\nEOF\nsleep 90");
  blocked("while [ ! -f /tmp/r ]; do sleep 2; done");
  blocked("gh run watch 1 && echo done");
});

test("the deadline clamp is applied regardless of what the patterns see", () => {
  assert.equal(mainBashPolicy({ command: "for i in 1 2 3; do sleep 3; done", timeout: 900 }).timeout, 60);
  assert.equal(mainBashPolicy({ command: "python3 -c 'import time; time.sleep(120)'" }).timeout, 60);
});
