import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundlePath, verified } from './cli_patch.mjs';

if (!verified(readFileSync(bundlePath, 'utf8'))) {
  throw new Error('Browser CLI shutdown patch is missing. Run node ~/.pi/agent/lib/browser/cli_patch.mjs before opening a browser.');
}
process.env.NO_UPDATE_NOTIFIER = '1';
const entry = new URL('../../npm/browser/node_modules/@playwright/cli/playwright-cli.js', import.meta.url);
process.argv[1] = fileURLToPath(entry);
await import(entry.href);
