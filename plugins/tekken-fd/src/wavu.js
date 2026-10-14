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

// ---- Curated punishers: Wavu "<Character> punishers" pages (community-chosen punish per frame window)

const SECTION = { standing: "standing", crouching: "crouching", backturnedopponent: "backturned", groundedopponent: "grounded" };
const int = (v) => {
  const m = String(v ?? "").match(/-?\d+/);
  return m ? Number(m[0]) : null;
};
const stripWiki = (v) => String(v ?? "")
  .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
  .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1").replace(/\[\[([^\]]*)\]\]/g, "$1")
  .replace(/''+/g, "").replace(/<[^>]+>/g, "").replace(/\u200b/g, "").trim();

/**
 * Parse a punishers page (template {{o| moveId = … }} format, or the older wikitable format).
 * @returns {{stance: string, enemy: number, moveId: string|null, move: string, damage: number|null, staple: number|null, mini: number|null, hard: boolean, note: string}[]}
 */
export function parsePunishers(wikitext, character) {
  const out = [];
  const text = String(wikitext ?? "");
  if (/\{\{o\|\s*moveId\s*=/.test(text)) {
    let stance = null;
    const re = /\|\s*([A-Za-z]+)\s*=\s*\{\{o\b|\{\{o\|((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/g;
    for (const m of text.matchAll(re)) {
      if (m[1]) {
        stance = SECTION[m[1].toLowerCase()] ?? null;
        continue;
      }
      if (!stance || !/moveId\s*=/.test(m[2])) continue;
      const kv = {};
      for (const part of m[2].split("|")) {
        const i = part.indexOf("=");
        if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
      }
      const moveId = stripWiki(kv.moveid).replace(/#/g, "${justFrame}");
      const enemy = int(kv.enemy); // may be absent (Jack-8): derived from the move's startup at index build
      out.push({
        stance, enemy, moveId,
        move: stripWiki(kv.move || moveId.slice(character.length + 1)).replace(/\$\{justFrame\}|#/g, ":"),
        damage: int(stripWiki(kv.damage)), staple: int(kv.staple), mini: int(kv.mini),
        hard: /^(true|yes|1)$/i.test(kv.hard ?? ""), note: stripWiki(kv.movenote ?? kv.risknote ?? ""),
      });
    }
    return out;
  }
  // older wikitable: "| colspan=… | Standing", rows "| -10 || 1,2,3 || 17 || +11g", rowspan carries the enemy value
  let stance = null;
  let carry = null;
  for (const row of text.split(/\n\|-/)) {
    const cat = row.match(/table-cat"\s*\|\s*([A-Za-z ]+)/);
    if (cat) {
      stance = SECTION[cat[1].replace(/\s+/g, "").toLowerCase()] ?? (/stand/i.test(cat[1]) ? "standing" : /crouch/i.test(cat[1]) ? "crouching" : null);
      carry = null;
      continue;
    }
    if (!stance) continue;
    const lines = row.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|") && !l.startsWith("|}") && !l.startsWith("|-"));
    if (!lines.length || lines[0].startsWith("!")) continue;
    let cells;
    const head = lines[0].match(/^\|\s*(?:rowspan="?(\d+)"?\s*\|\s*)?(-\d+)\s*$/);
    if (head) {
      // "| rowspan="3" | -10" on its own line, cells on the next line
      carry = { enemy: Number(head[2]), left: head[1] ? Number(head[1]) : 1 };
      cells = lines.slice(1).join(" ").replace(/^\|\s*/, "").split(/\s*\|\|\s*/);
    } else {
      cells = lines.join(" ").replace(/^\|\s*/, "").split(/\s*\|\|\s*/);
      const inline = cells[0].match(/^(?:rowspan="?(\d+)"?\s*\|\s*)?(-\d+)$/);
      if (inline) {
        carry = { enemy: Number(inline[2]), left: inline[1] ? Number(inline[1]) : 1 };
        cells = cells.slice(1);
      } else if (!carry || carry.left <= 0) continue;
    }
    if (!cells.length || !cells[0]) continue;
    carry.left--;
    const move = stripWiki(cells[0]);
    const dmg = stripWiki(cells[1] ?? "");
    const combo = dmg.match(/\((\d+)\)/);
    out.push({
      stance, enemy: carry.enemy, moveId: null, move: move.replace(/#/g, ":"),
      damage: int(dmg), staple: combo ? Number(combo[1]) : null, mini: null, hard: /\bhard\b/i.test(row), note: "",
    });
  }
  return out;
}

/** Fetch every character's punishers page (missing pages are skipped). */
export async function fetchPunishers(characters, { fetchImpl, pauseMs = 300 } = {}) {
  const out = {};
  for (const character of characters) {
    try {
      const body = await apiGet({ action: "parse", page: `${character} punishers`, prop: "wikitext", redirects: "1" }, { fetchImpl, retries: 1 });
      const entries = parsePunishers(body.parse?.wikitext?.["*"], character);
      if (entries.length) out[character] = entries;
    } catch {
      // page missing or unreadable: computed punishers remain the fallback
    }
    await sleep(pauseMs);
  }
  return out;
}
