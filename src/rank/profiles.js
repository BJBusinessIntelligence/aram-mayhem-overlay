// Champion trait profiles, 0..1 per trait, derived by rules from CommunityDragon playstyle data and
// aramkit combat stats (relative to the per-bracket averages), then patched by data/profile-overrides.json.
export const TRAITS = Object.freeze(['frontline', 'engage', 'peel', 'sustain', 'cc', 'poke']);
const STYLE_KEYS = ['damage', 'durability', 'crowdControl', 'mobility', 'utility'];

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mean = (...xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function EMPTY_PROFILE(id, name = `#${id}`) {
  return {
    id, riotId: null, name, icon: null, roles: [], ranged: false, physicalShare: 0.5, magicShare: 0.5, damageShare: 0.2,
    style: Object.fromEntries(STYLE_KEYS.map((k) => [k, 0.5])),
    frontline: 0, engage: 0, peel: 0, sustain: 0, cc: 0, poke: 0, burst: 0,
    sources: { cdragon: false, aramkit: false, override: false }, warnings: ['profile unavailable'],
  };
}

export function buildProfile({ id, riotId = null, name = `#${id}`, icon = null, cdragon = null, combat = null, averages = null, override = null }) {
  const warnings = [];
  const roles = cdragon?.roles ?? [];
  const has = (...rs) => rs.some((r) => roles.includes(r));
  const style = {};
  for (const k of STYLE_KEYS) {
    const v = cdragon?.playstyle?.[k];
    style[k] = typeof v === 'number' ? clamp01((v - 1) / 2) : 0.5;
  }
  if (!cdragon) warnings.push('champion profile unavailable');
  const ranged = cdragon ? cdragon.attackType === 'ranged' : false;

  const haveCombat = !!(combat && averages);
  if (!haveCombat) warnings.push('combat stats unavailable');
  // champion stat relative to the bracket average, capped at 2x; neutral (1) when unknown
  const ratio = (k) => {
    const c = combat?.[k]; const a = averages?.[k];
    return typeof c === 'number' && typeof a === 'number' && a > 0 ? Math.min(2, c / a) : 1;
  };
  const sumRatio = (ks) => {
    const c = ks.reduce((s, k) => s + (typeof combat?.[k] === 'number' ? combat[k] : NaN), 0);
    const a = ks.reduce((s, k) => s + (typeof averages?.[k] === 'number' ? averages[k] : NaN), 0);
    return Number.isFinite(c) && Number.isFinite(a) && a > 0 ? Math.min(2, c / a) : 1;
  };

  const phys = combat?.physicalDamage ?? 0; const mag = combat?.magicDamage ?? 0;
  const physicalShare = phys + mag > 0 ? phys / (phys + mag)
    : cdragon?.damageType === 'magic' ? 0.1 : cdragon?.damageType === 'physical' ? 0.9 : 0.5;

  const roleFront = has('tank') ? 1 : has('fighter') ? 0.6 : 0;
  const p = {
    id, riotId, name, icon, roles: roles.slice(), ranged,
    physicalShare, magicShare: 1 - physicalShare,
    damageShare: typeof combat?.damageShare === 'number' ? combat.damageShare : 0.2,
    style,
    frontline: clamp01(0.4 * style.durability + 0.3 * Math.min(1, ratio('damageSelfMitigated') / 2) + 0.3 * roleFront + (ranged ? 0 : 0.1)),
    engage: clamp01(mean(style.mobility, style.crowdControl, ranged ? 0.3 : 1) * (has('tank', 'fighter', 'assassin') ? 1 : 0.6)),
    peel: clamp01(mean(style.utility, style.crowdControl, ranged ? 1 : 0.4) * (has('support', 'mage') ? 1 : 0.6)),
    sustain: clamp01(sumRatio(['healsOnTeammates', 'damageShieldedOnTeammates']) / 2),
    cc: clamp01(mean(style.crowdControl, Math.min(1, ratio('timeCcingOthers') / 2))),
    poke: ranged ? clamp01(mean(style.damage, 1 - style.durability) * (has('mage', 'marksman') ? 1 : 0.6)) : 0,
    burst: clamp01(style.damage * (ranged || has('assassin') ? 1 : 0.6)),
    sources: { cdragon: !!cdragon, aramkit: haveCombat, override: false },
    warnings,
  };
  if (override && typeof override === 'object') {
    for (const t of TRAITS) if (typeof override[t] === 'number') p[t] = clamp01(override[t]);
    p.sources.override = true;
  }
  return p;
}
