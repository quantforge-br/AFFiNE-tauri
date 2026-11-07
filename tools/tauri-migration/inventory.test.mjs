import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const generated = execFileSync(process.execPath, ['tools/tauri-migration/inventory.mjs'], { cwd: root, encoding: 'utf8' });
const manifest = JSON.parse(generated);

test('inventory is reproducible and matches the committed baseline', () => {
  assert.equal(generated, readFileSync(path.join(root, 'docs/tauri-migration/ipc-inventory.json'), 'utf8'));
  assert.equal(generated, execFileSync(process.execPath, ['tools/tauri-migration/inventory.mjs'], { cwd: root, encoding: 'utf8' }));
});

test('all baseline command and event members are accounted for', () => {
  assert.equal(manifest.entries.length, 177);
  assert.equal(manifest.entries.filter(entry => entry.kind === 'command').length, 153);
  assert.equal(manifest.entries.filter(entry => entry.kind === 'event').length, 24);
  assert.equal(new Set(manifest.entries.map(entry => entry.id)).size, 177);
  assert.equal(manifest.namespaces.length, 30);
  assert.equal(manifest.namespaces.reduce((total, namespace) => total + namespace.members, 0) + 1, 177);
});

test('aliases, full reexports, literal event names and preload wrappers resolve', () => {
  for (const id of [
    'command:configStorage:get',
    'command:db:getDocAsUpdates',
    'command:nbstore:indexSearch',
    'command:import:createImportSessionFromSource',
    'event:power:power-source',
    'event:ui:onActiveTabChanged',
    'event:diskSync:onEvent',
  ]) assert.ok(manifest.entries.some(entry => entry.id === id), id);
});

test('source locations point to the exact baseline member', () => {
  const sources = new Map();
  for (const entry of manifest.entries) {
    if (!sources.has(entry.source)) {
      sources.set(entry.source, execFileSync('git', ['show', manifest.reference + ':' + entry.source], { cwd: root, encoding: 'utf8' }).split('\n'));
    }
    const line = sources.get(entry.source)[entry.line - 1];
    assert.ok(line?.includes(entry.method), entry.id + ' must point to its definition');
  }
});

test('an inventory is not falsely reported as implementation or platform evidence', () => {
  for (const entry of manifest.entries) {
    assert.equal(entry.implementation, null);
    assert.deepEqual(entry.verification, []);
    assert.deepEqual(entry.platforms, { linux: 'pending', windows: 'pending', macos: 'pending' });
  }
});
