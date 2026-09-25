# aramgg.com Data API

This document describes the public Data API for third-party integrations. The API is hosted on Tencent Cloud EdgeOne Pages Functions and uses API keys for business data endpoints.

## Basic Information

- Recommended domain: `https://data.dtodo.cn`
- Current version path: `/api/v1/en/`
- Supported locales: `zh-CN`, `zh-TW`, `en`, `ja`, `ko`, `vi`
- Current locale: `en`
- Authentication: business data endpoints require an API key; `config.json` and this document are public
- Developer console: `https://data.dtodo.cn/developer.html`
- Main-site locale paths `fr`, `tr`, `pl`, `de`, `pt-BR`, and `es` transparently fall back to the English API; response locale values and resource links remain `en`
- Data format: JSON
- Data release version: see `dataVersion` in `/api/v1/en/config.json`
- Recommended endpoints: use `/api/v1/en/augments.json`, `/api/v1/en/champions.json`, `/api/v1/en/items.json`, `/api/v1/en/summoner-spells.json`, and `/api/v1/en/champions/{championId}.json`
- Compatibility policy: fields may be added; existing public fields are not removed or renamed within `/api/v1/` while the game data still exists
- Update frequency: follows aramgg.com data refreshes; realtime updates are not guaranteed
- Ratio fields: win rate and pick rate use `0-1` decimals, so `0.5234` means `52.34%`
- Text fields: descriptions can contain HTML-like tags such as `<br>`, `<scaleBonus>`, and `<rules>`

Example request:

```text
GET https://data.dtodo.cn/api/v1/en/champions/266.json
Authorization: Bearer hx_live_...
```

You can also send the key with:

```text
x-api-key: hx_live_...
```

For a main-site locale without native API data, keep that locale in the path and the API serves the English equivalent. For example:

```text
GET https://data.dtodo.cn/api/v1/fr/champions/266.json
Authorization: Bearer hx_live_...
```

## Authentication and Quotas

Create API keys in the developer console. The free plan currently includes 200 credits per day.

| Path | Cost |
| --- | --- |
| `/api/v1/en/augments.json` | 1 credit |
| `/api/v1/en/champions.json` | 1 credit |
| `/api/v1/en/items.json` | 1 credit |
| `/api/v1/en/summoner-spells.json` | 1 credit |
| `/api/v1/en/champions/{championId}.json` | 2 credits |
| `/api/v1/en/config.json` | 0 credits, no API key required |
| `/api/v1/en/docs/cf-data-api.md` | 0 credits, no API key required |

Data responses include credit headers:

```text
x-credits-cost
x-credits-used-today
x-credits-daily
x-credits-remaining
```

Invalid keys return `401`, quota or rate-limit errors return `429`, and missing files return `404`. `HEAD` requests still require an API key for protected data endpoints, but do not consume data credits.
Protected data endpoints accept only `GET` and `HEAD`. Other HTTP methods return `405 Method Not Allowed` with `Allow: GET, HEAD`.

## File List

| Path | Purpose |
| --- | --- |
| `/api/v1/en/config.json` | API release config, data version, and client update metadata |
| `/api/v1/en/augments.json` | Expanded augment list with English names, icons, stats, stage performance, and top champions |
| `/api/v1/en/champions.json` | Champion ranking with English names, titles, roles, icons, and stats |
| `/api/v1/en/champions/{championId}.json` | Single champion detail with augments, items, augment trios, builds, summoner spells, skill orders, and related articles |
| `/api/v1/en/items.json` | Expanded item data with item icon URLs |
| `/api/v1/en/summoner-spells.json` | Summoner spell IDs, English names, and complete icon URLs |
| `/api/v1/en/data/aram-mayhem-augments.en_us.json` | English augment metadata |
| `/api/v1/en/data/augments-stats-raw.json` | Raw augment stats |
| `/api/v1/en/data/champions-stats.json` | Raw champion stats |
| `/api/v1/en/data/champion-augments/{championId}.json` | Per-champion augment, item, and trio stats |
| `/api/v1/en/data/champions-names-i18n.json` | Champion IDs, aliases, roles, names, and titles |
| `/api/v1/en/data/summoner-spells-i18n.json` | Localized summoner spell names and upstream icon filenames used by builds; expanded endpoints return `https://cdn.dtodo.cn/hextech/summoner-spell-icons/{spellId}.png` |
| `/api/v1/en/data/items-en_us.json` | English item metadata |
| `/api/v1/en/data/builds/HOWLING_ABYSS_ARAM/{championId}.json` | Raw champion build stats |

The `/api/v1/en/data/*` files preserve the source site structure and can contain tuple arrays or stringified JSON. New integrations should prefer the expanded endpoints above.

## Response Envelope

Expanded endpoints return:

```ts
interface ApiEnvelope<T> {
  meta: {
    service: "aramgg-data-api";
    schemaVersion: 1;
    apiVersion: "v1";
    locale: "en";
    gamePatch: string;
    apiRelease: number;
    dataVersion: string;
    generatedAt: string;
    publishedAt: string | null;
    resource: string;
    total?: number;
  };
  data: T;
}
```

Notes:

- Stats are already converted to `number` or `null`.
- `stats_json` fields are expanded in recommended endpoints.
- Champion, augment, item, and summoner spell icons include complete CDN URLs. Augment `iconUrl` uses the fully rendered, full-color `iconLarge` asset, so consumers do not need to composite the transparent mask themselves.
- `winRate` and `pickRate` remain `0-1` decimals.
- `/api/v1/en/champions/{championId}.json` returns one object and does not include `meta.total`.
- Augments added by the current changelog but not yet covered by the stats snapshot are still included in `augments.json`. They use `statsAvailable: false`, all-`null` `stats`, and empty `stages` and `topChampions`; `config.gamePatch` continues to identify the stats snapshot.
- `data.augments[*].stats` includes integer `rank` and `total`. Sort ascending by `rank`; lower values have higher recommendation priority. Recommendation order remains sourced from Tencent. Once a champion-Augment row has at least 255 anonymously uploaded client games, `winRate`, `wins`, and `games` contain statistics aggregated across all uploaded servers; `winRateSource`, `winRateRegion: "WORLD"`, and `winRateMinimumGames` identify their provenance, aggregation scope, and threshold. Rows below the threshold remain `null`.
- `data.augmentTrios[*].stats` uses the same numeric stats shape with `source: "aramgg-client-upload"`. A trio is emitted after at least 151 games; one qualifying trio is sufficient, and each champion returns up to five sorted by win rate and games.

## Build Recommendations

`data.builds` is an array of 1–4 same-patch iesdev variants per champion, ordered by games and pick rate. Each variant keeps its own label, games, wins, pick rate, win rate, core items, starting items, situational items, summoner spells, and complete 18-level skill orders. Situational items exclude items already present in the first three core builds, omit entries below a `0.5%` pick rate, and keep the first 12 after sorting by pick rate, games, and item ID. The current source does not expose a verifiable six-item `fullItems` field, so that compatibility array remains empty rather than being inferred from item orders. Summoner spells and skill orders come from the same build record without a cross-patch fallback. The legacy `data.build` alias equals `data.builds[0] ?? null`.

```ts
interface BuildRecommendation {
  summonerSpells: Array<{
    summonerSpellIds: number[];
    spells: Array<{ id: number; name: string; iconUrl: string }>;
    games: number;
    wins: number;
    pickRate: number;
    winRate: number;
  }>;
  skillOrders: Array<{
    skillOrder: number[]; // complete 18-level choices; 1/2/3/4 map to Q/W/E/R
    skillKeys: Array<"Q" | "W" | "E" | "R">;
    games: number;
    wins: number;
    pickRate: number;
    winRate: number;
  }>;
}
```

## Config

Path: `/api/v1/en/config.json`

```ts
interface DataApiConfig {
  service: "aramgg-data-api";
  schemaVersion: 1;
  apiVersion: "v1";
  locale: "en";
  gamePatch: string;
  apiRelease: number;
  dataVersion: string;
  generatedAt: string;
  publishedAt: string | null;
  configRevision?: string;
  dataBasePath: string;
  docs: string;
  electron: {
    latestVersion: string;
    downloadUrl: string;
  };
}
```

`gamePatch` is the League of Legends patch. `apiRelease` increments within the same game patch, and `dataVersion` combines both values, for example `16.10.3`.

## Localization Notes

- English endpoints use `aram-mayhem-augments.en_us.json`, `items-en_us.json`, and English values from `champions-names-i18n.json`.
- Related blog links use `https://aramgg.com/en/blog/{slug}`.
- Missing text falls back to English, then Simplified Chinese, then the first available value.
- Japanese, Korean, and Vietnamese have native endpoints under `/api/v1/ja/*`, `/api/v1/ko/*`, and `/api/v1/vi/*`.
- Main-site aliases `fr`, `tr`, `pl`, `de`, `pt-BR`, and `es` apply to public config/docs and protected business endpoints. Authentication and credit costs are unchanged; unlisted locales do not silently fall back.
- The official client API under `/api/client/v1/*` supports `zh-CN`, `zh-TW`, and `en-US`. Requests without a locale remain Simplified Chinese for compatibility; English uses `?locale=en-US` and `/api/client/v1/data/{dataVersion}/en-US/*`.
