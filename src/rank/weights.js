// Every tunable number of the recommender and build adaptation lives here.
export const WEIGHTS = Object.freeze({
  components: Object.freeze({ strength: 0.6, fit: 0.3, synergy: 0.1 }),
  traits: Object.freeze({ frontline: 1.0, balance: 1.0, engage: 0.8, peel: 0.8, cc: 0.7, sustain: 0.6, poke: 0.6 }),
  fitNeutral: 0.25,          // fit value assumed when no ally is known
  shrinkGames: 20_000,       // K in (wr·n + 0.5·K)/(n + K)
  lowSampleGames: 50_000,    // below this: low-sample warning + confidence hit
  fallbackStrength: Object.freeze({ floor: 0.45, range: 0.15 }), // maps shrunk win rate to 0..1 when rankings are unavailable
  defaultDamageShare: 0.2,   // assumed damageShare for a profile that doesn't report one
  teamSize: 4,               // full ARAM side size, used to scale fit confidence and ally knowledge
  reasonMinGain: 0.15,       // trait gain needed to become a reason
  reasonMinSynergy: 0.4,
  lackThreshold: 0.4,        // coverage below this after adding the candidate → "team still lacks"
  coverageThreshold: 0.6,    // UI ✓/✗ cut for the team strip
  archetypeCapPp: 3,         // max win-rate points a composition need may add to an archetype
  archetypeMinPick: 0.05,
  itemCapPp: 3,
  itemMinPick: 0.01,
  maxSituational: 3,
  antiHealItems: Object.freeze([3123, 3033, 3165, 3011, 3075]),
});
