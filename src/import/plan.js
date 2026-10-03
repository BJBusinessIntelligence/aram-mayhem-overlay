// Turns a pickBuild() result into what the League client accepts: a summoner spell pair and one
// item set per champion. Pure; the importer decides when to write and the writer talks to the LCU.
export const HEALTH_POTION = 2003;
export const AMO_PREFIX = 'AMO · ';

const validId = (id) => Number.isInteger(id) && id > 0;

function block(type, items) {
  const ids = [...new Set((items ?? []).map((i) => i && i.id).filter(validId))];
  if (ids.length === 0) return null;
  return { type, items: ids.map((id) => ({ id: String(id), count: 1 })), hideIfSummonerSpell: '', showIfSummonerSpell: '' };
}

export function planImport({ champ, build, enemies = 0 }) {
  const p = build?.primary;
  if (!champ || !p) return { spells: null, itemSet: null };
  const spells = Array.isArray(p.spellIds) && p.spellIds.length === 2 && p.spellIds.every(validId)
    ? { ids: p.spellIds.slice(), names: Array.isArray(p.spells) ? p.spells.slice() : [] }
    : null;
  const blocks = [
    block('Start', [...(p.starter ?? []), { id: HEALTH_POTION }]),
    block('Boots', p.boots ? [p.boots] : []),
    block('Core (in order)', p.core ?? []),
    block('Later', p.later ?? []),
    enemies > 0 ? block(`Situational vs ${enemies} enemies`, (build.situational ?? []).map((s) => s.item)) : null,
  ].filter(Boolean);
  const itemSet = {
    title: `${AMO_PREFIX}${champ.name}`, type: 'custom', map: 'any', mode: 'any',
    associatedChampions: [champ.id], associatedMaps: [], sortrank: 0, startedFrom: 'blank', preferredItemSlots: [],
    uid: `amo-${champ.id}`, blocks,
  };
  return { spells, itemSet };
}

export function fingerprint(plan, phase) {
  const spells = plan?.spells ? plan.spells.ids.join('+') : '-';
  const blocks = (plan?.itemSet?.blocks ?? []).map((b) => `${b.type}:${b.items.map((i) => i.id).join(',')}`).join(';');
  return `${phase}|${spells}|${blocks}`;
}
