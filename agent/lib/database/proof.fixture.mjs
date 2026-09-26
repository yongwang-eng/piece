import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const output = process.argv[2];
if (!output) throw new Error('usage: node proof.fixture.mjs <evidence-directory>');
mkdirSync(output, { recursive: true });
const source = readFileSync(join(here, 'store.ts'), 'utf8');
const mutations = [
  ['generation', ' || r.generation !== h.generation', '', 'owner release/reclaim fences old callbacks'],
  ['crew-owner', "if (c.owner_id !== main.id) throw new Error('crew belongs to another owner');", '', 'different main owners cannot mutate each other'],
  ['membership', "if (!membership) throw new Error('worker is not a crew member');", '', 'worker mutations require the actual crew binding'],
];
for (const [name, before, after, target] of mutations) {
  assert.equal(source.split(before).length, 2, `${name}: exact unique mutation site`);
  const root = mkdtempSync(join(tmpdir(), 'crew-proof-'));
  const temp = join(root, 'agent/lib/database');
  mkdirSync(temp, { recursive: true });
  mkdirSync(join(root, 'agent/npm'), { recursive: true });
  symlinkSync(join(here, '../../npm/crew'), join(root, 'agent/npm/crew'));
  try {
    for (const file of ['schema.ts', 'schema-ddl.ts', 'usage.ts', 'store.test.mjs', 'concurrency.fixture.mjs']) copyFileSync(join(here, file), join(temp, file));
    writeFileSync(join(temp, 'store.ts'), source.replace(before, after));
    const result = spawnSync(process.execPath, ['--test', join(temp, 'store.test.mjs')], { encoding: 'utf8', timeout: 10000 });
    const log = result.stdout + result.stderr;
    writeFileSync(join(output, `mutant-${name}.log`), log);
    assert.equal(result.status, 1, `${name}: broken invariant must fail`);
    assert.ok(log.split('\n').some(line => line.includes(target) && (line.includes('✖') || line.includes('not ok'))), `${name}: intended assertion must fail`);
    const control = 'registration precedes execution, duplicate start is idempotent and rebinding is refused';
    assert.ok(log.split('\n').some(line => line.includes(control) && (line.includes('✔') || /^ok /.test(line))), `${name}: unrelated control must pass`);
    console.log(`${name}: intended guard RED; registration/execution control GREEN`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
