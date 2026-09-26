import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fresh install has no ~/.pi/agent/state. The transition log is the ONLY record when
// notifications are off, so if nothing creates the directory the append silently no-ops and the
// documented log never exists. os.homedir() honours $HOME, and paths.ts resolves at module load,
// so a dynamic import under a temp HOME gives us a genuinely clean agent dir.
test('statePath creates the state directory on a clean install so the log is writable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-bgc-home-'));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { statePath } = await import(`./paths.ts?clean=${Date.now()}`);
    const p = statePath('compaction.log');

    assert.equal(p, join(home, '.pi', 'agent', 'state', 'compaction.log'));
    assert.ok(existsSync(join(home, '.pi', 'agent', 'state')), 'state/ exists before the first append');

    appendFileSync(p, 'first transition\n');
    assert.match(readFileSync(p, 'utf8'), /first transition/, 'the documented log actually records');
  } finally {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  }
});
