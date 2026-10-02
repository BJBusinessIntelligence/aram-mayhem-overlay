import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChampionIndex } from '../../src/data/champions.js';
import { fixture } from '../helpers/fixtures.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

const champIndex = createChampionIndex(fixture('aramkit', 'resources-champions.json'));
const synergyRules = readJson('data/synergy-rules.json');
const profileOverrides = readJson('data/profile-overrides.json');

const ALLOWED_OVERRIDE_KEYS = new Set(['frontline', 'engage', 'peel', 'sustain', 'cc', 'poke', 'note']);

test('every synergy rule pair resolves to a known riot id', () => {
  for (const rule of synergyRules) {
    assert.ok(champIndex.byRiotId(rule.a), `rule.a "${rule.a}" does not resolve via byRiotId`);
    assert.ok(champIndex.byRiotId(rule.b), `rule.b "${rule.b}" does not resolve via byRiotId`);
  }
});

test('every synergy rule has a numeric delta', () => {
  for (const rule of synergyRules) {
    assert.equal(typeof rule.delta, 'number', `rule ${rule.a}/${rule.b} delta is not numeric`);
    assert.ok(Number.isFinite(rule.delta), `rule ${rule.a}/${rule.b} delta is not finite`);
  }
});

test('every profile override key resolves to a known riot id', () => {
  for (const key of Object.keys(profileOverrides)) {
    assert.ok(champIndex.byRiotId(key), `override key "${key}" does not resolve via byRiotId`);
  }
});

test('every profile override only uses allowed trait keys', () => {
  for (const [key, override] of Object.entries(profileOverrides)) {
    for (const field of Object.keys(override)) {
      assert.ok(ALLOWED_OVERRIDE_KEYS.has(field), `override "${key}" has unexpected key "${field}"`);
    }
  }
});
