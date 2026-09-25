export const LIVE_URL = 'https://127.0.0.1:2999/liveclientdata/allgamedata';
const PREFIX = 'game_character_displayname_';

export function stripChampionPrefix(raw) {
  if (typeof raw !== 'string') return null;
  return raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;
}

export function extractActive(data) {
  const ap = data?.activePlayer;
  const players = data?.allPlayers;
  if (!ap || !Array.isArray(players)) return null;
  const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
  const byRiot = ap.riotId ? players.find((p) => lower(p?.riotId) === lower(ap.riotId)) : null;
  const bySummoner = ap.summonerName ? players.find((p) => lower(p?.summonerName) === lower(ap.summonerName)) : null;
  const me = byRiot ?? bySummoner;
  if (!me) return null;
  return {
    championRiotId: stripChampionPrefix(me.rawChampionName) ?? me.championName ?? null,
    championName: me.championName ?? null,
    level: typeof ap.level === 'number' && Number.isFinite(ap.level) ? ap.level : null,
    gameMode: data?.gameData?.gameMode ?? null,
  };
}

export function createLiveClient({ getJson, url = LIVE_URL, timeoutMs = 1500 }) {
  return {
    async snapshot() {
      try {
        const { status, body } = await getJson(url, { timeoutMs, rejectUnauthorized: false });
        if (status !== 200) return { connected: false };
        const active = extractActive(body);
        return active ? { connected: true, ...active } : { connected: false };
      } catch {
        return { connected: false };
      }
    },
  };
}
