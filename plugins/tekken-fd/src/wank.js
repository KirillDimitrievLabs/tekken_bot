// Ranked matchup statistics from Wavu Wank (https://wank.wavu.wiki), built only on an owner command.
// Only aggregated counts are stored; no player ids, names or replays leave this module.
import { USER_AGENT } from "./wavu.js";

export const WANK_URL = "https://wank.wavu.wiki";
const WINDOW_S = 700; // /api/replays returns the 700 s ending at `before`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rank ids in replays run 0–36 (37 ranks). The only numbered public list puts Bushin at 25,
 * Tekken King at 26 and God of Destruction I–VII at 30–36; names below that are not needed.
 */
export const BANDS = {
  all: { minRank: 0, label: { en: "all ranks", ru: "все ранги" } },
  king: { minRank: 26, label: { en: "Tekken King+", ru: "Tekken King+" } },
  god: { minRank: 30, label: { en: "God of Destruction", ru: "God of Destruction" } },
};

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** One request at a time, polite pace, retries with backoff on 429/5xx and network errors. */
export async function wankGet(path, { fetchImpl = fetch, retries = 4, timeoutMs = 30000 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(`${WANK_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" } });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return path.startsWith("/api/") ? await res.json() : await res.text();
    } catch (err) {
      last = err;
      if (attempt === retries || (err.message?.startsWith("HTTP 4") && !err.retry)) break;
      await sleep(2000 * 2 ** attempt);
    }
  }
  throw new Error(`wank.wavu.wiki ${path} failed: ${last?.message ?? last}`);
}

/** Character leaderboard slugs and display names from a regional leaderboard page. */
export function parseLeaderboardNav(html, region = "eu") {
  const out = [];
  for (const m of String(html).matchAll(new RegExp(`href="/leaderboard/${region}/([a-z0-9-]+)">([^<]+)</a>`, "g"))) out.push({ slug: m[1], name: m[2].trim() });
  return [...new Map(out.map((x) => [x.slug, x])).values()];
}

/** Polaris ids listed on one character leaderboard page. */
export const parseLeaderboardPlayers = (html) => [...new Set([...String(html).matchAll(/href="\/player\/([A-Za-z0-9]+)"/g)].map((m) => m[1]))];

/** Map Wank character names to our index names (exact after normalisation; a few known spellings). */
export function matchCharacterName(name, characters) {
  const aliases = { yoshi: "yoshimitsu", jack8: "jack8", devil: "deviljin", dvj: "deviljin", ak: "armorking" };
  const n = aliases[norm(name)] ?? norm(name);
  return characters.find((c) => norm(c) === n) ?? null;
}

/**
 * Character id → name by majority vote: players on a character's leaderboard mostly play that character.
 * @param {Map<string, Map<number, number>>} seen polaris id → (chara_id → games)
 * @param {Map<string, string[]>} boards character name → polaris ids on its leaderboards
 */
export function voteCharacterIds(seen, boards) {
  const votes = new Map(); // chara_id → Map(name → votes)
  for (const [name, ids] of boards) {
    for (const id of ids) {
      const games = seen.get(id);
      if (!games) continue;
      const [top] = [...games.entries()].sort((a, b) => b[1] - a[1]);
      const v = votes.get(top[0]) ?? new Map();
      v.set(name, (v.get(name) ?? 0) + 1);
      votes.set(top[0], v);
    }
  }
  const map = {};
  const used = new Set();
  // strongest votes first so a character name is assigned to one id only
  const ranked = [...votes.entries()].map(([id, v]) => [id, [...v.entries()].sort((a, b) => b[1] - a[1])])
    .sort((a, b) => (b[1][0]?.[1] ?? 0) - (a[1][0]?.[1] ?? 0));
  for (const [id, options] of ranked) {
    const pick = options.find(([name, n]) => !used.has(name) && n >= 2);
    if (pick) { map[id] = pick[0]; used.add(pick[0]); }
  }
  return map;
}

const expected = (ra, rb) => 1 / (1 + 10 ** ((rb - ra) / 400));

/** Streaming aggregate: counts per unordered character pair and band, mirror matches excluded. */
export class MatchupAggregator {
  /** @param {Set<string>|null} tracked only these polaris ids are counted for character-id mapping (memory) */
  constructor(tracked = null) {
    this.tracked = tracked;
    this.pairs = new Map(); // "a|b" (a<b numerically) → { band: [games, winsOfA, adjSum, adjGames] }
    this.chars = new Map(); // id → { band: [games, wins] }
    this.seen = new Map();  // polaris id → Map(chara_id → games), kept in memory only for id mapping
    this.replays = 0;
    this.from = Infinity;
    this.to = 0;
  }
  add(r) {
    const a = r.p1_chara_id, b = r.p2_chara_id;
    if (!Number.isInteger(a) || !Number.isInteger(b) || ![1, 2].includes(r.winner)) return;
    this.replays++;
    this.from = Math.min(this.from, r.battle_at);
    this.to = Math.max(this.to, r.battle_at);
    for (const [pid, cid] of [[r.p1_polaris_id, a], [r.p2_polaris_id, b]]) {
      if (!pid || (this.tracked && !this.tracked.has(pid))) continue;
      const m = this.seen.get(pid) ?? new Map();
      m.set(cid, (m.get(cid) ?? 0) + 1);
      this.seen.set(pid, m);
    }
    const minRank = Math.min(r.p1_rank ?? 0, r.p2_rank ?? 0);
    const bands = Object.entries(BANDS).filter(([, b]) => minRank >= b.minRank).map(([k]) => k);
    for (const [cid, won] of [[a, r.winner === 1], [b, r.winner === 2]]) {
      const c = this.chars.get(cid) ?? {};
      for (const band of bands) { const v = (c[band] ??= [0, 0]); v[0]++; v[1] += won ? 1 : 0; }
      this.chars.set(cid, c);
    }
    if (a === b) return;
    const [lo, hi, loWon, rLo, rHi] = a < b ? [a, b, r.winner === 1, r.p1_rating_before, r.p2_rating_before]
      : [b, a, r.winner === 2, r.p2_rating_before, r.p1_rating_before];
    const key = `${lo}|${hi}`;
    const p = this.pairs.get(key) ?? {};
    for (const band of bands) {
      const v = (p[band] ??= [0, 0, 0, 0]);
      v[0]++; v[1] += loWon ? 1 : 0;
      if (Number.isFinite(rLo) && Number.isFinite(rHi)) { v[2] += (loWon ? 1 : 0) - expected(rLo, rHi); v[3]++; }
    }
    this.pairs.set(key, p);
  }
  /** Final, name-keyed, player-free snapshot. Unmapped character ids are dropped and reported. */
  snapshot(idToName, meta) {
    const name = (id) => idToName[id];
    const characters = {};
    for (const [id, bands] of this.chars) if (name(id)) characters[name(id)] = bands;
    const matchups = {};
    for (const [key, bands] of this.pairs) {
      const [lo, hi] = key.split("|").map(Number);
      if (!name(lo) || !name(hi)) continue;
      const [first, second] = [name(lo), name(hi)];
      const flip = first.localeCompare(second) > 0;
      const k = flip ? `${second}|${first}` : `${first}|${second}`;
      // stored as [games, wins of the first name, rating-adjusted surplus ×1000 of the first name, games with ratings]
      matchups[k] = Object.fromEntries(Object.entries(bands).map(([band, [g, w, adj, adjN]]) =>
        [band, flip ? [g, g - w, Math.round(-adj * 1000), adjN] : [g, w, Math.round(adj * 1000), adjN]]));
    }
    const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    const unmapped = [...this.chars.keys()].filter((id) => !name(id)).sort((x, y) => x - y);
    return { ...meta, replays: this.replays, from: new Date(this.from * 1000).toISOString(), to: new Date(this.to * 1000).toISOString(),
      bands: Object.fromEntries(Object.entries(BANDS).map(([k, b]) => [k, { minRank: b.minRank, label: b.label.en }])),
      unmappedCharacterIds: unmapped, characters: sorted(characters), matchups: sorted(matchups) };
  }
}

/**
 * Scan the current patch's ranked replays backwards for up to `days`, then map character ids
 * through the leaderboards. ~123 requests per day at one per second (the pace Wank's API page suggests).
 */
export async function fetchMatchupStats(characters, { days = 7, fetchImpl, pauseMs = 1000, onProgress, now = () => Date.now() } = {}) {
  // 1) leaderboards first: only their players are tracked for the id mapping, so memory stays small
  //    (a few thousand ids instead of every player in a week of replays).
  const boards = new Map();
  const navs = [];
  for (const region of ["eu", "am"]) {
    const nav = parseLeaderboardNav(await wankGet(`/leaderboard/${region}`, { fetchImpl }), region);
    navs.push(...nav.map((n) => ({ ...n, region })));
    if (pauseMs) await sleep(pauseMs);
  }
  let done = 0;
  for (const { slug, name, region } of navs) {
    const ours = matchCharacterName(name, characters);
    onProgress?.({ phase: "leaderboards", done: ++done, total: navs.length, character: ours ?? name });
    if (!ours) continue;
    const ids = parseLeaderboardPlayers(await wankGet(`/leaderboard/${region}/${slug}`, { fetchImpl }));
    boards.set(ours, [...(boards.get(ours) ?? []), ...ids]);
    if (pauseMs) await sleep(pauseMs);
  }
  // 2) replays of the current game version, newest first
  const agg = new MatchupAggregator(new Set([...boards.values()].flat()));
  const windows = Math.ceil((days * 86400) / WINDOW_S);
  let before = null;
  let version = null;
  let stoppedAtPatch = false;
  for (let i = 0; i < windows; i++) {
    const body = await wankGet(`/api/replays${before == null ? "" : `?before=${before}`}`, { fetchImpl });
    if (!Array.isArray(body) || !body.length) break;
    if (before == null) before = Math.max(...body.map((r) => r.battle_at));
    version ??= Math.max(...body.map((r) => r.game_version ?? 0));
    const current = body.filter((r) => r.game_version === version);
    for (const r of current) agg.add(r);
    onProgress?.({ phase: "replays", done: i + 1, total: windows, replays: agg.replays, gameVersion: version });
    if (current.length < body.length * 0.5) { stoppedAtPatch = true; break; } // previous patch reached
    before -= WINDOW_S;
    if (pauseMs) await sleep(pauseMs);
  }
  const idToName = voteCharacterIds(agg.seen, boards);
  agg.seen.clear(); // player ids never leave this function
  return agg.snapshot(idToName, { source: `${WANK_URL}/api/replays (ranked)`, gameVersion: version, days, stoppedAtPatch, builtAt: new Date(now()).toISOString(),
    characterIds: Object.fromEntries(Object.entries(idToName).sort((x, y) => Number(x[0]) - Number(y[0]))) });
}

// ---- reading the snapshot for the coach

/** Minimum games before a win rate is shown at all, and before it is called reliable. */
export const MIN_GAMES = { show: 150, reliable: 500 };

/** A's view of A vs B in one band: {games, winRate, adjusted, reliable} or null. */
export function matchupStat(stats, a, b, band) {
  if (!stats?.matchups || a === b) return null;
  const flip = a.localeCompare(b) > 0;
  const row = stats.matchups[flip ? `${b}|${a}` : `${a}|${b}`]?.[band];
  if (!row || row[0] < MIN_GAMES.show) return null;
  const [games, winsFirst, adjFirst, adjGames] = row;
  const wins = flip ? games - winsFirst : winsFirst;
  const adj = flip ? -adjFirst : adjFirst;
  return { games, winRate: wins / games, adjusted: adjGames ? 0.5 + adj / 1000 / adjGames : null, reliable: games >= MIN_GAMES.reliable };
}

/** Overall win rate of a character in one band. */
export function characterStat(stats, c, band) {
  const row = stats?.characters?.[c]?.[band];
  if (!row || row[0] < MIN_GAMES.show) return null;
  return { games: row[0], winRate: row[1] / row[0], reliable: row[0] >= MIN_GAMES.reliable };
}

/** Pick the highest band with a reliable sample (king before all); god is too thin for most pairs. */
export function bestBand(stats, a, b) {
  for (const band of ["king", "all"]) {
    const s = b ? matchupStat(stats, a, b, band) : characterStat(stats, a, band);
    if (s?.reliable) return { band, ...s };
  }
  const s = b ? matchupStat(stats, a, b, "all") : characterStat(stats, a, "all");
  return s ? { band: "all", ...s } : null;
}

/** Qualitative wording the model may use; numbers are rendered by code only. */
export function verdict(winRate) {
  if (winRate >= 0.55) return "favourable";
  if (winRate >= 0.52) return "slightly favourable";
  if (winRate > 0.48) return "even";
  if (winRate > 0.45) return "slightly hard";
  return "hard";
}
