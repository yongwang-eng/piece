import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(join(dirname(process.execPath), '../lib/node_modules/@earendil-works/pi-coding-agent/package.json'));
const tuiLib = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
const source = stripTypeScriptTypes(readFileSync(new URL('./decision-picker.ts', import.meta.url), 'utf8')).replace(/^import .*;\s*$/gm, '').replaceAll('export function ', 'function ');
const factory = new Function('SelectList', 'Text', 'matchesKey', 'Key', source + '\nreturn decisionPicker;');
const make = factory(tuiLib.SelectList, tuiLib.Text, tuiLib.matchesKey, tuiLib.Key);

test('production picker preserves full implications with scrolling and binds Enter to the highlighted key', () => {
  let chosen;
  const options = [
    { key: 'a', label: 'Keep', description: ('Long consequence with an important detail. ').repeat(25) + 'END_OF_CONSEQUENCE' },
    { key: 'b', label: 'Resolve', description: 'Resolve only the specified row.' },
  ];
  const panel = make({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_c, s) => s }, key => { chosen = key; }, 'What should happen to the row?', options);
  for (const width of [20, 40, 80]) {
    const lines = panel.render(width);
    assert.ok(lines.length <= 24);
    assert.ok(lines.every(line => tuiLib.visibleWidth(line) <= width));
  }
  assert.equal(chosen, undefined, 'rendering does not choose');
  panel.render(40);
  for (let i = 0; i < 30; i++) panel.handleInput('\x1b[6~');
  assert.match(panel.render(40).join('\n'), /END_OF_CONSEQUENCE/);
  panel.handleInput('\x1b[B');
  assert.match(panel.render(40).join('\n'), /Resolve only the specified row/);
  panel.handleInput('\r');
  assert.equal(chosen, 'b');
});

test('Escape dismisses without an approval', () => {
  const results = [];
  const panel = make({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_c, s) => s }, key => results.push(key), 'Question?', [{ key: 'a', label: 'Keep', description: 'Keep it.' }]);
  panel.handleInput('\x1b');
  assert.deepEqual(results, [undefined]);
});

test('picker has side padding and breathing room around sections', () => {
  const panel = make({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_c, s) => s }, () => {}, 'Question?', [{ key: 'a', label: 'Keep', description: 'Keep it.' }], 'Context.');
  const lines = panel.render(60);
  assert.equal(lines[0].trim(), '');
  for (const value of ['Question?', 'Context.', '→ Keep', 'Keep it.']) {
    const index = lines.findIndex(line => line.trim() === value);
    assert.ok(index >= 0, value);
    assert.ok(lines[index].startsWith('  '), value);
    assert.equal(lines[index - 1].trim(), '', value);
  }
});
