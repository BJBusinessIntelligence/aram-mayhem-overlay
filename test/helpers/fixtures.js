import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixture(...segments) {
  return JSON.parse(readFileSync(path.join(root, ...segments), 'utf8'));
}

export function aramkitResources() {
  return {
    champions: fixture('aramkit', 'resources-champions.json'),
    augments: fixture('aramkit', 'resources-augments.json'),
    items: fixture('aramkit', 'resources-items.json'),
    spells: fixture('aramkit', 'resources-summoner-spells.json'),
    archetypes: fixture('aramkit', 'resources-archetypes.json'),
  };
}
