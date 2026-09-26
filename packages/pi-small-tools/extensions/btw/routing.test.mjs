import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as core from './core.ts';

const sdkRoot = join(dirname(process.execPath), '../lib/node_modules/@earendil-works/pi-coding-agent');
const require = createRequire(join(sdkRoot, 'package.json'));
const tuiLib = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')));
const sdk = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')));
const { InteractiveMode } = await import(pathToFileURL(join(sdkRoot, 'dist/modes/interactive/interactive-mode.js')));
const { initTheme } = await import(pathToFileURL(join(sdkRoot, 'dist/modes/interactive/theme/theme.js')));
initTheme('dark');
const source = stripTypeScriptTypes(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace('export default function btw', 'function btw');
const flush = () => new Promise(setImmediate);

function harness() {
  let command, resolveModel, signal, aborts = 0, closes = 0;
  let editorText = 'unfinished main input';
  const terminal = { columns: 100, rows: 35, hideCursor() {}, write() {} };
  const ui = new tuiLib.TuiAltScreen(terminal);
  ui.requestRender = () => {};
  ui.requestImmediateRender = () => {};
  const editor = {
    render: () => ['main working'], invalidate() {},
    getText: () => editorText, setText: text => { editorText = text; },
    handleInput(data) { if (tuiLib.matchesKey(data, 'escape')) aborts++; },
  };
  const host = { ui, editor, editorContainer: new tuiLib.Container(), keybindings: {}, disposeActiveSelector() {} };
  host.editorContainer.addChild(editor);
  ui.addChild(host.editorContainer);
  ui.setFocus(editor);
  runInNewContext(`${source}\nbtw(pi);`, {
    ...tuiLib, ...core, BorderedLoader: sdk.BorderedLoader, getMarkdownTheme: sdk.getMarkdownTheme,
    buildSessionContext: entries => ({ messages: entries }), convertToLlm: messages => messages,
    randomUUID: () => 'side-fixture', AbortController, setTimeout, clearTimeout,
    pi: { registerCommand(_name, c) { command = c; }, on() {} },
  });
  const ctx = {
    mode: 'tui', model: { id: 'fixture' },
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    modelRegistry: { complete(_model, _context, options) {
      signal = options.signal;
      return new Promise(resolve => { resolveModel = resolve; });
    } },
    ui: { notify() {}, custom: (factory, options) => InteractiveMode.prototype.showExtensionCustom.call(host, factory, options) },
  };
  return {
    ui, host, editor, run: () => command.handler('Side question', ctx).then(() => { closes++; }),
    resolve: () => resolveModel({ stopReason: 'stop', content: [{ type: 'text', text: 'Side answer' }] }),
    state: () => ({ aborts, closes, editorText, sideAborted: signal.aborted }),
  };
}

for (const phase of ['loading', 'answer']) {
  test(`${phase}: ctx-style panel owns input; one Escape closes only btw`, async () => {
    const h = harness(), run = h.run();
    await flush();
    try {
      if (phase === 'answer') { h.resolve(); await flush(); }
      assert.equal(h.ui.hasOverlay(), false, 'btw must use the editor-replacement surface');
      assert.notEqual(h.host.editorContainer.children[0], h.editor);
      h.ui.handleTerminalInput('\x1b');
      await run;
      assert.deepEqual(h.state(), { aborts: 0, closes: 1, editorText: 'unfinished main input', sideAborted: true });
      assert.equal(h.host.editorContainer.children[0], h.editor);
      if (phase === 'loading') { h.resolve(); await flush(); }
      assert.equal(h.state().closes, 1, 'late answers must not reopen the panel');
      h.ui.handleTerminalInput('\x1b');
      assert.equal(h.state().aborts, 1, 'a separate Escape still reaches main after dismissal');
    } finally {
      if (!h.state().closes) h.ui.handleTerminalInput('\x1b');
      await run;
    }
  });
}
