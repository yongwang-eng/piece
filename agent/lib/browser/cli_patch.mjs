import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const bundlePath = fileURLToPath(new URL('../../npm/browser/node_modules/playwright-core/lib/coreBundle.js', import.meta.url));
const ORIGINAL = '7aa0bf8b6b69d32065912e3d8f7e3c18c62de4d668f770a8e039811d3cf9c6a0';
const PATCHED = '219b8f69c5b5a207601e424294de9ea55947edfb7da38a84a5f56c83c5a1cb06';
const digest = (text) => createHash('sha256').update(text).digest('hex');

export function verified(source) {
  return digest(source) === PATCHED;
}

export function patchSource(source) {
  if (verified(source)) return source;
  if (digest(source) !== ORIGINAL) throw new Error('Unknown Playwright bundle; refusing to patch. Review the pinned dependency before upgrading.');
  // Stop and context-close both enter shutdown; re-entry force-kills Chrome before cookies flush.
  const anchor = 'function gracefullyProcessExitDoNotHang(code, onExit2) {\n';
  const result = source.replace(anchor, 'let piBrowserExitStarted = false;\n' + anchor + '  if (piBrowserExitStarted) return;\n  piBrowserExitStarted = true;\n');
  if (!verified(result)) throw new Error('Playwright shutdown patch checksum mismatch');
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const source = readFileSync(bundlePath, 'utf8');
  const patched = patchSource(source);
  if (patched !== source) {
    writeFileSync(bundlePath + '.tmp', patched);
    renameSync(bundlePath + '.tmp', bundlePath);
  }
  console.log('Playwright CLI shutdown patch verified');
}
