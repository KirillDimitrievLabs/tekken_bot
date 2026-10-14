// Wavu Wiki (https://wavu.wiki) Cargo API client for Tekken 8 move data.
// Content is CC BY-SA 4.0 — replies credit wavu.wiki.

export const API_URL = "https://wavu.wiki/w/api.php";
export const USER_AGENT = "clan-bots/tekken-fd (frame data Telegram bot; contact: klokd2@gmail.com)";

// Every column of the Move table except media (image/video).
export const MOVE_FIELDS = [
  "id", "num", "name", "input", "alias", "alt", "parent",
  "target", "damage", "reach", "tracksLeft", "tracksRight",
  "startup", "recv", "tot", "crush", "block", "hit", "ch", "notes",
];

const PAGE_SIZE = 500;
const MOVELIST_SUFFIX = " movelist";
// Non-character pages that also store rows in the Move table.
const EXCLUDED_PAGES = new Set(["Generic movelist"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(params, { fetchImpl = fetch, retries = 3 } = {}) {
  const url = `${API_URL}?${new URLSearchParams({ format: "json", ...params })}`;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`API error: ${body.error.code} ${body.error.info ?? ""}`.trim());
      return body;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`wavu.wiki request failed: ${lastError?.message ?? lastError}`);
}

/** Character name from a Cargo page name ("Jack-8 movelist" → "Jack-8"), or null for non-character pages. */
export function characterFromPage(page) {
  if (!page || EXCLUDED_PAGES.has(page) || !page.endsWith(MOVELIST_SUFFIX)) return null;
  return page.slice(0, -MOVELIST_SUFFIX.length);
}

function cleanRow(row) {
  const out = {};
  for (const field of MOVE_FIELDS) {
    const value = row[field];
    out[field] = value === null || value === undefined || value === "" ? null : String(value);
  }
  return out;
}

/**
 * Fetch every Tekken 8 move, grouped by character.
 * @returns {Promise<Map<string, object[]>>} character → rows
 */
export async function fetchAllMoves({ fetchImpl, pauseMs = 400 } = {}) {
  const byCharacter = new Map();
  let offset = 0;
  for (;;) {
    const body = await apiGet({
      action: "cargoquery",
      tables: "Move",
      fields: [...MOVE_FIELDS.map((f) => `Move.${f}=${f}`), "Move._pageName=page"].join(","),
      where: `Move._pageName LIKE '%${MOVELIST_SUFFIX}'`,
      order_by: "Move._ID",
      limit: String(PAGE_SIZE),
      offset: String(offset),
    }, { fetchImpl });
    const rows = (body.cargoquery ?? []).map((r) => r.title);
    for (const row of rows) {
      const character = characterFromPage(row.page);
      if (!character || !row.id) continue;
      if (!byCharacter.has(character)) byCharacter.set(character, []);
      byCharacter.get(character).push(cleanRow(row));
    }
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(pauseMs);
  }
  for (const [character, moves] of byCharacter) byCharacter.set(character, dedupeById(moves));
  return byCharacter;
}

const filled = (row) => Object.values(row).filter((v) => v !== null).length;

/** Wavu occasionally stores the same move id twice; keep the most complete row. */
export function dedupeById(moves) {
  const best = new Map();
  for (const m of moves) {
    const cur = best.get(m.id);
    if (!cur || filled(m) > filled(cur)) best.set(m.id, m);
  }
  return [...best.values()];
}

/**
 * Tekken 8 movelist pages edited since `sinceIso` (Wavu recentchanges).
 * @returns {Promise<{characters: string[], edits: number}>}
 */
export async function fetchChangedCharacters(sinceIso, knownCharacters, { fetchImpl } = {}) {
  const known = new Set(knownCharacters);
  const changed = new Set();
  let edits = 0;
  let cont = {};
  for (let page = 0; page < 20; page++) {
    const body = await apiGet({
      action: "query",
      list: "recentchanges",
      rcnamespace: "0",
      rcprop: "title|timestamp",
      rctype: "edit|new",
      rcend: sinceIso,
      rclimit: "500",
      ...cont,
    }, { fetchImpl });
    for (const rc of body.query?.recentchanges ?? []) {
      const character = characterFromPage(rc.title);
      if (character && known.has(character)) {
        changed.add(character);
        edits++;
      }
    }
    if (!body.continue?.rccontinue) break;
    cont = { rccontinue: body.continue.rccontinue };
  }
  return { characters: [...changed].sort(), edits };
}
