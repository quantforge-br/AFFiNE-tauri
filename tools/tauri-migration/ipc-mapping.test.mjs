import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BOUNDARIES,
  loadInventory,
  loadMapping,
  methodsByKey,
  render,
  STATES,
} from './ipc-mapping.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mapping = loadMapping();
const inventory = loadInventory();
const methods = methodsByKey(inventory);

test('every inventory record has exactly one mapping and nothing else is mapped', () => {
  const mapped = mapping.records.map(r => r.key);
  assert.equal(new Set(mapped).size, mapped.length, 'duplicate mapping keys');
  assert.deepEqual([...mapped].sort(), [...methods.keys()].sort());
});

test('member counts match the inventory and groups partition the methods exactly', () => {
  for (const record of mapping.records) {
    const expected = methods.get(record.key);
    assert.equal(record.members, expected.length, record.key + ' members');
    if (!record.groups) continue;
    const listed = Object.values(record.groups).flat();
    assert.equal(new Set(listed).size, listed.length, record.key + ' repeats');
    assert.deepEqual([...listed].sort(), [...expected].sort(), record.key);
  }
  const total = mapping.records.reduce((sum, r) => sum + r.members, 0);
  assert.equal(total, inventory.entries.length);
  assert.equal(total, 177);
});

test('records declare a known boundary, state, callers and a design', () => {
  for (const r of mapping.records) {
    assert.ok(BOUNDARIES.has(r.boundary), r.key + ' boundary');
    assert.ok(STATES.has(r.state), r.key + ' state');
    assert.ok(r.replaces && r.design && r.service, r.key + ' text');
    assert.ok(r.matrix.length > 0, r.key + ' parity');
    for (const caller of r.callers)
      assert.ok(mapping.callerClasses[caller], r.key + ' caller ' + caller);
    if (r.boundary === 'not-applicable') {
      assert.equal(r.members, 0, r.key + ' must be an empty registry');
      assert.deepEqual(r.callers, []);
    } else {
      assert.ok(r.callers.length > 0, r.key + ' callers');
      assert.ok(r.members > 0, r.key + ' members');
    }
    assert.ok(!('implementation' in r) && !('verification' in r), r.key);
  }
});

test('only the storage record claims partial diagnostic coverage', () => {
  const partial = mapping.records
    .filter(r => r.state !== 'proposed')
    .map(r => r.key);
  assert.deepEqual(partial, ['helper:command:nbstore']);
});

test('every parity item is referenced and every reference exists', () => {
  const matrix = readFileSync(
    resolve(root, 'docs/tauri-migration/parity-matrix.md'),
    'utf8'
  );
  const defined = new Set(
    [...matrix.matchAll(/^\| (P\d\d) \|/gm)].map(m => m[1])
  );
  assert.equal(defined.size, 28);
  const referenced = new Set([
    ...mapping.records.flatMap(r => r.matrix),
    ...mapping.nonIpcSurfaces.map(s => s.matrix),
  ]);
  for (const id of referenced) assert.ok(defined.has(id), 'unknown ' + id);
  assert.deepEqual(
    [...defined].filter(id => !referenced.has(id)),
    [],
    'parity items without a destination'
  );
});

test('platform differences stay explicit', () => {
  const recording = mapping.records.find(
    r => r.key === 'main:command:recording'
  );
  assert.equal(recording.platforms.linux, 'not-applicable-as-reference');
  assert.equal(recording.platforms.windows, 'required');
});

test('the committed document is the rendering of the mapping', () => {
  const committed = readFileSync(
    resolve(root, 'docs/tauri-migration/ipc-mapping.md'),
    'utf8'
  );
  assert.equal(committed, render(mapping, inventory));
});
