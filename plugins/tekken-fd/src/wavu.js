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

/** "Reina combos" / "Reina punishers" → "Reina" (other synced Wavu pages). */
export function characterFromDataPage(page) {
  const m = String(page ?? "").match(/^(.+) (?:combos|punishers)$/);
  return m ? m[1] : null;
}

/**
 * Fetch every Tekken 8 move, grouped by character.
 * @returns {Promise<Map<string, object[]>>} character → rows
 */
export async function fetchAllMoves({ fetchImpl, pauseMs = 400, onProgress } = {}) {
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
    onProgress?.({ rows: offset + rows.length, characters: byCharacter.size });
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
      const character = characterFromPage(rc.title) ?? characterFromDataPage(rc.title);
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

/**
 * Run `fetchOne(character)` for every character, sequentially and politely.
 * onProgress({done, total, character, status}) — status "ok" | "missing" (no page / no entries) | "error".
 * @returns {Promise<{data: object, report: {ok: number, missing: string[], errors: string[]}}>}
 */
async function perCharacter(characters, fetchOne, { pauseMs, onProgress }) {
  const data = {};
  const report = { ok: 0, missing: [], errors: [] };
  let done = 0;
  for (const character of characters) {
    let status = "missing";
    try {
      const value = await fetchOne(character);
      if (value && Object.keys(value).length) {
        data[character] = value;
        status = "ok";
      }
    } catch (err) {
      status = /missingtitle|HTTP 404/.test(err.message) ? "missing" : "error";
    }
    if (status === "ok") report.ok++;
    else report[status === "missing" ? "missing" : "errors"].push(character);
    onProgress?.({ done: ++done, total: characters.length, character, status });
    await sleep(pauseMs);
  }
  return { data, report };
}

/** Fetch every character's punishers page (missing pages are skipped). */
export async function fetchPunishers(characters, { fetchImpl, pauseMs = 300, onProgress, withReport = false } = {}) {
  const r = await perCharacter(characters, async (character) => {
    const body = await apiGet({ action: "parse", page: `${character} punishers`, prop: "wikitext", redirects: "1" }, { fetchImpl, retries: 1 });
    return parsePunishers(body.parse?.wikitext?.["*"], character);
  }, { pauseMs, onProgress });
  return withReport ? r : r.data;
}

// ---- Combo damage: Wavu "<Character> combos" pages ("; [23] EWGF" launcher lines, ": [+56] route" lines)

const NON_NOTATION = /\b(?:on crouching opp\.?|on block|low parry|wall|airborne|side|back|from|vs|only)\b/i;

/** "CH (f+2),3,F" → {key: "f+2,3,F", ch: true}; "EWGF (f,n,d,df#2)" → "f,n,d,df:2"; null when not a move. */
export function launcherKey(label) {
  let t = stripWiki(label).replace(/\s+/g, " ").trim();
  const ch = /^CH\s+/i.test(t);
  t = t.replace(/^CH\s+/i, "").replace(/^(?:deep\s+)?dash\s+|^cc\s+|^ss\s+(?=\d)/i, "");
  const inner = t.match(/\(([^()]*[0-9][^()]*)\)\s*$/); // "EWGF (f,n,d,df#2)" → notation in brackets
  if (inner && !/^[(]/.test(t) && !/[,+]/.test(t.replace(/\(.*$/, ""))) t = inner[1];
  t = t.replace(/\s*\((?:on |vs |from |if |when )[^)]*\)\s*$/i, ""); // trailing situation notes
  t = t.replace(/[()]/g, "").replace(/#/g, ":").trim();
  if (!t || NON_NOTATION.test(t)) return null;
  if (!/\d/.test(t)) return /^[A-Za-z][A-Za-z ]{1,24}$/.test(t) ? { key: t, ch, named: true } : null; // "EWGF", "WGF", "Hellsweep"
  if (/\s\S+\s/.test(t)) return null;
  return { key: t.split(" ")[0], ch };
}

const usesResource = (route) => /(?:^|[\s,])(?:H\.|R\.)|(?:^|\s)2\+3(?:\s|$)/.test(route);

/**
 * @returns {{label, key, ch, base, best, bestHeat, hard, section}[]} best = best route without Heat/Rage
 */
export function parseCombos(wikitext, character) {
  const out = [];
  let section = "";
  let group = [];
  let routes = [];
  const flush = () => {
    if (!group.length) return;
    const plain = routes.filter((r) => !r.resource);
    const easy = plain.filter((r) => !r.hard);
    for (const g of group) {
      const k = launcherKey(g.label);
      if (!k || g.base === null) continue;
      out.push({
        label: g.label, key: k.key, ch: k.ch, named: Boolean(k.named), base: g.base, section,
        best: (easy[0] ?? plain[0]) ? Math.max(...(easy.length ? easy : plain).map((r) => r.plus)) : null,
        bestHeat: routes.length ? Math.max(...routes.map((r) => r.plus)) : null,
        hard: !easy.length && plain.length > 0,
      });
    }
    group = [];
    routes = [];
  };
  for (const raw of String(wikitext ?? "").split("\n")) {
    const line = raw.trim();
    const h = line.match(/^==+\s*([^=]+?)\s*==+$/);
    if (h) {
      flush();
      section = /stapl/i.test(h[1]) ? "staples" : /mini/i.test(h[1]) ? "mini" : h[1].toLowerCase();
      continue;
    }
    const l = line.match(/^;\s*(?:\[(\d+)\])?\s*(.+)$/);
    if (l) {
      if (routes.length) flush();
      group.push({ base: l[1] ? Number(l[1]) : null, label: l[2] });
      continue;
    }
    const r = line.match(/^:\s*\[\+(\d+)(?:\s*;[^\]]*)?\]\s*(.*)$/); // "[+56]" or "[+51; 34]"
    if (r && group.length) {
      const route = stripWiki(r[2]);
      routes.push({ plus: Number(r[1]), resource: usesResource(route), hard: /name="?hard"?|\(hard\)|hard\b/i.test(r[2]) });
    }
  }
  flush();
  // keep the best entry per launcher key (staples beat mini-combos; normal hit beats CH)
  const merged = new Map();
  for (const e of out) {
    const k = `${e.ch ? "ch:" : ""}${e.key}`;
    const prev = merged.get(k);
    if (!prev) {
      merged.set(k, { ...e });
      continue;
    }
    // plain (no Heat/Rage) routes decide; Heat-only routes only raise bestHeat
    const total = (x) => (x.best === null ? -1 : x.best + x.base);
    const keep = total(e) > total(prev) ? { ...e } : prev;
    keep.bestHeat = Math.max(prev.bestHeat ?? 0, e.bestHeat ?? 0) || null;
    keep.hard = keep === prev ? prev.hard : e.hard;
    merged.set(k, keep);
  }
  return [...merged.values()];
}

export async function fetchCombos(characters, { fetchImpl, pauseMs = 300, onProgress, withReport = false } = {}) {
  const r = await perCharacter(characters, async (character) => {
    const body = await apiGet({ action: "parse", page: `${character} combos`, prop: "wikitext", redirects: "1" }, { fetchImpl, retries: 1 });
    return parseCombos(body.parse?.wikitext?.["*"], character);
  }, { pauseMs, onProgress });
  return withReport ? r : r.data;
}

// ---- TekkenDocs (https://tekkendocs.com) move tags — second source for homing/step/duck/tornado

const TD_URL = "https://tekkendocs.com/api/t8";
const tdSlug = (c) => c.toLowerCase().replace(/\s+/g, "-");

/** {character: {moveId: {hom?, stp?, dck?, trn?, intr?}}} — only the tags the bot uses. */
export async function fetchTekkenDocsTags(characters, { fetchImpl = fetch, pauseMs = 300, onProgress, withReport = false } = {}) {
  const keep = ["hom", "stp", "dck", "trn", "intr"];
  const r = await perCharacter(characters, async (character) => {
    const res = await fetchImpl(`${TD_URL}/${tdSlug(character)}/framedata`, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const tags = {};
    for (const m of body.framesNormal ?? []) {
      const t = Object.fromEntries(Object.entries(m.tags ?? {}).filter(([k]) => keep.includes(k)));
      if (Object.keys(t).length && m.id) tags[m.id] = t;
    }
    return tags;
  }, { pauseMs, onProgress });
  return withReport ? r : r.data;
}
