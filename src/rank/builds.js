// Highest win rate among entries with pickRate >= minPick; if none qualify, among all.
function best(list, minPick) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const qualified = list.filter((x) => (x.pickRate ?? 0) >= minPick);
  const pool = qualified.length ? qualified : list;
  return pool.slice().sort((a, b) => ((b.winRate ?? -1) - (a.winRate ?? -1)) || ((b.games ?? 0) - (a.games ?? 0)))[0];
}

export function pickBuild(champData, { minPick = 0.05 } = {}) {
  const archetypes = champData?.build?.archetypes ?? [];
  if (archetypes.length === 0) return null;
  const primary = best(archetypes, minPick);
  const spells = best(champData.summoners, minPick);
  const skill = best(champData.skills, minPick);
  return {
    primary: {
      key: primary.key,
      name: primary.name,
      winRate: primary.winRate,
      pickRate: primary.pickRate,
      games: primary.games,
      starter: primary.starters[0]?.items ?? [],
      boots: primary.boots[0]?.item ?? null,
      core: primary.core,
      later: primary.later.map((l) => l.item),
      spells: spells?.names ?? [],
      skillOrder: skill?.order ?? null,
      routeWinRate: primary.routeWinRate,
      routeGames: primary.routeGames,
    },
    alternatives: archetypes
      .filter((a) => a !== primary)
      .map((a) => ({ key: a.key, name: a.name, winRate: a.winRate, pickRate: a.pickRate, games: a.games })),
  };
}
