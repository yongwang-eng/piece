import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as database from './store.ts';
import { SCHEMA_VERSION } from './schema.ts';

test('shared database exposes the Crew store and creates only the current schema', t => {
  assert.equal(typeof database.openCrewStore, 'function');
  const root = mkdtempSync(join(tmpdir(), 'pi-database-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = database.agentDbPath(root);
  assert.equal(path, join(root, 'state', 'agent.sqlite'));
  const store = database.openCrewStore(path);
  store.close();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name),
      ['agents', 'compactions', 'consults', 'crew_members', 'crew_meta', 'crews', 'devin_events', 'devin_sessions', 'model_calls', 'turns']);
    assert.equal(db.prepare('SELECT version FROM crew_meta').get().version, SCHEMA_VERSION);
  } finally { db.close(); }
});

test('Crew uses the shared path; the retired Fleet extension and its store are gone (backlog #5, D52)', () => {
  const crew = readFileSync(new URL('../../extensions/crew/index.ts', import.meta.url), 'utf8');
  assert.match(crew, /sharedRegistry\(pi, agentDbPath\(AGENT_DIR\)\)/);
  assert.doesNotMatch(crew, /crew-store|crew\.sqlite/);
  assert.equal(existsSync(new URL('../../extensions/fleet/', import.meta.url)), false, 'extensions/fleet was deleted 2026-09-16; the substrate it left (lib/governor, lib/room, lib/agent-ui, workers/constitution.md) stays');
  assert.equal(existsSync(new URL('../crew-store/', import.meta.url)), false);
});
