// SQLite index built from the git snapshots (node:sqlite, no dependencies).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanInline, listText, noteItems } from "./format.js";
import { blockOf, inputTiming, isLauncher, isThrow, reachOf, recoveryOf, startupOf, stanceOf, totalOf } from "./frames.js";
import { tagsFor } from "./tags.js";
import { looseKey, moveKeyFromId, strictKey } from "./notation.js";

const SCHEMA = `
CREATE TABLE characters (name TEXT PRIMARY KEY, lname TEXT NOT NULL, moves INTEGER NOT NULL);
CREATE TABLE moves (
  id TEXT PRIMARY KEY, character TEXT NOT NULL, key TEXT NOT NULL, num INTEGER,
  name TEXT, input TEXT, alias TEXT, alt TEXT, parent TEXT,
  target TEXT, damage TEXT, startup TEXT, recv TEXT, tot TEXT, crush TEXT,
  block TEXT, hit TEXT, ch TEXT, notes TEXT,
  root INTEGER, startup_n INTEGER, startup_eff INTEGER, timing_note TEXT, block_n INTEGER, launcher INTEGER, stance TEXT, throw INTEGER,
  recv_n INTEGER, tot_n INTEGER, reach_n REAL, throw_break TEXT, heat_dash TEXT, root_id TEXT
);
CREATE INDEX moves_parent ON moves (parent);
CREATE INDEX moves_punish ON moves (character, root, stance, startup_eff);
CREATE TABLE tags (id TEXT NOT NULL, character TEXT NOT NULL, tag TEXT NOT NULL);
CREATE INDEX tags_lookup ON tags (character, tag);
CREATE TABLE move_keys (character TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, strict TEXT NOT NULL, loose TEXT NOT NULL);
CREATE INDEX move_keys_strict ON move_keys (character, strict);
CREATE INDEX move_keys_loose ON move_keys (character, loose);
CREATE VIRTUAL TABLE moves_fts USING fts5(id UNINDEXED, character UNINDEXED, text, tokenize='trigram');
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE punishers (character TEXT NOT NULL, stance TEXT NOT NULL, enemy INTEGER NOT NULL, move_id TEXT, key TEXT NOT NULL,
  staple INTEGER, mini INTEGER, damage INTEGER, hard INTEGER NOT NULL, note TEXT);
CREATE INDEX punishers_lookup ON punishers (character, stance, enemy);
`;

const COLUMNS = ["id", "character", "key", "num", "name", "input", "alias", "alt", "parent",
  "target", "damage", "startup", "recv", "tot", "crush", "block", "hit", "ch", "notes",
  "root", "startup_n", "startup_eff", "timing_note", "block_n", "launcher", "stance", "throw",
  "recv_n", "tot_n", "reach_n", "throw_break", "heat_dash", "root_id"];

/** Alternative inputs/nicknames in Wavu's alias/alt fields (plain value or an HTML "dotlist"). */
function altKeys(value, character) {
  return noteItems(value).map((v) => moveKeyFromId(v, character)).filter(Boolean);
}

/** "Throw break: 1 or 2" → "1 or 2"; "none" for unbreakable; null if not a throw note. */
export function throwBreakOf(notes) {
  for (const n of noteItems(notes)) {
    let m = n.match(/^throw break[:\s]*(1\+2|1 or 2|3\+4|1|2|none)\b/i) ?? n.match(/^(1\+2|1 or 2|3\+4|1|2) throw break\b/i);
    if (m) return m[1].toLowerCase();
    if (/^unbreakable\b|cannot (?:be )?(?:throw )?break|can'?t (?:be )?(?:throw )?break/i.test(n)) return "none";
  }
  return null;
}

/** "Heat Dash +5, +43d (+35)" → "+5, +43d (+35)". */
export function heatDashOf(notes) {
  for (const n of noteItems(notes)) {
    const m = n.match(/^heat dash\s+([+-]\d.*)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

/** Build the index atomically: write to a temp file, then rename over dbPath. */
export function buildDatabase(dbPath, snapshots, meta = {}, punishers = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  try {
    db.exec(SCHEMA);
    const insChar = db.prepare("INSERT INTO characters VALUES (?, ?, ?)");
    const insMove = db.prepare(`INSERT INTO moves (${COLUMNS.join(",")}) VALUES (${COLUMNS.map(() => "?").join(",")})`);
    const insKey = db.prepare("INSERT INTO move_keys VALUES (?, ?, ?, ?, ?)");
    const insFts = db.prepare("INSERT INTO moves_fts VALUES (?, ?, ?)");
    const insTag = db.prepare("INSERT INTO tags VALUES (?, ?, ?)");
    db.exec("BEGIN");
    const byId = new Map([...snapshots.values()].flat().map((m) => [m.id, m]));
    const rootOf = (m) => {
      let cur = m;
      for (let guard = 0; cur.parent && byId.has(cur.parent) && guard < 20; guard++) cur = byId.get(cur.parent);
      return cur;
    };
    const kidsOf = new Map();
    for (const m of byId.values()) if (m.parent) (kidsOf.get(m.parent) ?? kidsOf.set(m.parent, []).get(m.parent)).push(m);
    let total = 0;
    const seen = new Set();
    for (const [character, moves] of snapshots) {
      insChar.run(character, character.toLowerCase(), moves.length);
      for (const m of moves) {
        if (seen.has(m.id)) continue; // Wavu duplicate rows: first (most complete after dedupe) wins
        seen.add(m.id);
        const key = moveKeyFromId(m.id, character);
        const root = rootOf(m);
        const timing = inputTiming(key, m);
        const name = m.name ? listText(m.name, " / ") : null;
        const aliases = altKeys(m.alias, character);
        const alts = altKeys(m.alt, character);
        const v = (x) => x ?? null;
        insMove.run(m.id, character, key, m.num == null ? null : Number(m.num), name, v(m.input), aliases.join(" · ") || null, alts.join(" · ") || null, v(m.parent),
          v(m.target), v(m.damage), v(m.startup), v(m.recv), v(m.tot), v(m.crush), v(m.block), v(m.hit), v(m.ch), v(m.notes),
          m.parent ? 0 : 1, startupOf(m.startup), timing.eff, timing.note || null, cleanInline(m.block) === "!" ? null : blockOf(m.block),
          isLauncher(m.hit) ? 1 : 0, stanceOf(key), isThrow(m.target) ? 1 : 0,
          recoveryOf(m.recv), totalOf(m.tot), reachOf(m.reach), throwBreakOf(m.notes), heatDashOf(m.notes), root.id);
        for (const tag of tagsFor(m, key, root, kidsOf.get(m.id) ?? [])) insTag.run(m.id, character, tag);
        const keys = [["id", key], ...aliases.map((k) => ["alias", k]), ...alts.map((k) => ["alt", k])];
        for (const [kind, k] of keys) insKey.run(character, m.id, kind, strictKey(k), looseKey(k));
        insFts.run(m.id, character, [key, name, ...aliases, ...alts].filter(Boolean).join(" | "));
        total++;
      }
    }
    const insPun = db.prepare("INSERT INTO punishers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const byLoose = db.prepare("SELECT DISTINCT id FROM move_keys WHERE character = ? AND loose = ?");
    const byStrict = db.prepare("SELECT DISTINCT id FROM move_keys WHERE character = ? AND strict = ?");
    for (const [character, entries] of Object.entries(punishers ?? {})) {
      for (const e of entries) {
        let id = e.moveId && byId.has(e.moveId) ? e.moveId : null;
        if (!id && e.move) {
          // older table pages give only the input ("DF+1,3", "WS+4,4"): match by notation
          const strict = byStrict.all(character, strictKey(e.move));
          const loose = strict.length ? strict : byLoose.all(character, looseKey(e.move));
          if (loose.length === 1) id = loose[0].id;
        }
        let enemy = e.enemy;
        if (enemy === null || enemy === undefined) {
          const s0 = id ? startupOf(rootOf(byId.get(id)).startup) : null;
          if (s0 === null) continue;
          enemy = -s0;
        }
        insPun.run(character, e.stance, enemy, id, e.move || (id ? moveKeyFromId(id, character) : "?"), e.staple ?? null, e.mini ?? null, e.damage ?? null, e.hard ? 1 : 0, e.note || null);
      }
    }
    const insMeta = db.prepare("INSERT INTO meta VALUES (?, ?)");
    for (const [k, v] of Object.entries({ ...meta, builtAt: new Date().toISOString(), moves: total })) insMeta.run(k, String(v));
    db.exec("COMMIT");
  } catch (err) {
    db.close();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  db.close();
  fs.renameSync(tmp, dbPath);
}

/** Read-only handle that transparently reopens after a rebuild (file replaced). */
export class MoveIndex {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.ino = null;
  }

  handle() {
    const st = fs.statSync(this.dbPath, { throwIfNoEntry: false });
    if (!st) throw new Error("frame data index not built yet — owner must run /fd_sync or /fd_rebuild");
    if (!this.db || st.ino !== this.ino) {
      this.db?.close();
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      this.ino = st.ino;
    }
    return this.db;
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  characters() {
    return this.handle().prepare("SELECT name, moves FROM characters ORDER BY name").all();
  }

  meta() {
    return Object.fromEntries(this.handle().prepare("SELECT k, v FROM meta").all().map((r) => [r.k, r.v]));
  }

  move(id) {
    return this.handle().prepare("SELECT * FROM moves WHERE id = ?").get(id) ?? null;
  }

  /** root → … → move, following parent links (cycle-safe). */
  chain(id) {
    const out = [];
    const seen = new Set();
    for (let cur = this.move(id); cur && !seen.has(cur.id); cur = cur.parent ? this.move(cur.parent) : null) {
      seen.add(cur.id);
      out.unshift(cur);
    }
    return out;
  }

  byKey(character, column, value) {
    return this.handle()
      .prepare(`SELECT DISTINCT m.* FROM move_keys k JOIN moves m ON m.id = k.id WHERE k.character = ? AND k.${column} = ? ORDER BY k.kind = 'id' DESC, m.num`)
      .all(character, value);
  }

  byName(character, text) {
    return this.handle()
      .prepare("SELECT * FROM moves WHERE character = ? AND lower(name) = lower(?) ORDER BY num")
      .all(character, text);
  }

  /** Trigram full-text search over key/name/alias: every word of ≥ 3 chars must appear. */
  search(character, text, limit = 8) {
    const words = String(text).toLowerCase().split(/[^a-z0-9+,.:~*']+/).filter((w) => w.length >= 3);
    if (!words.length) return [];
    const match = `text : (${words.map((w) => `"${w.replace(/"/g, "")}"`).join(" AND ")})`;
    return this.handle()
      .prepare(`SELECT m.* FROM moves_fts f JOIN moves m ON m.id = f.id
                WHERE moves_fts MATCH ? AND f.character = ? ORDER BY rank LIMIT ?`)
      .all(match, character, limit);
  }

  /** Moves whose loose key contains the query's loose key ("qcf2" → "df+1+3,qcf+2"). */
  containsLoose(character, loose, limit = 8) {
    if (loose.length < 2) return [];
    return this.handle()
      .prepare(`SELECT DISTINCT m.* FROM move_keys k JOIN moves m ON m.id = k.id
                WHERE k.character = ? AND instr(k.loose, ?) > 0 ORDER BY length(k.loose), m.num LIMIT ?`)
      .all(character, loose, limit);
  }

  /** Root moves usable from a stance with startup ≤ frames (punish candidates). */
  punishCandidates(character, stance, frames) {
    return this.handle()
      .prepare(`SELECT * FROM moves WHERE character = ? AND root = 1 AND throw = 0 AND stance = ?
                AND startup_eff IS NOT NULL AND startup_eff <= ? ORDER BY startup_eff, num`)
      .all(character, stance, frames);
  }

  /** Root moves with guaranteed on-block ≤ threshold. */
  unsafeMoves(character, threshold) {
    return this.handle()
      .prepare(`SELECT * FROM moves WHERE character = ? AND root = 1 AND block_n IS NOT NULL AND block_n <= ?
                ORDER BY block_n, num`)
      .all(character, threshold);
  }

  /** Rows matching a raw SQL condition for one character (internal helper for feature modules). */
  where(character, condition, params = [], order = "num") {
    return this.handle().prepare(`SELECT * FROM moves WHERE character = ? AND (${condition}) ORDER BY ${order}`).all(character, ...params);
  }

  tagsOf(id) {
    return this.handle().prepare("SELECT tag FROM tags WHERE id = ?").all(id).map((r) => r.tag);
  }

  /** Curated punishers usable at `frames` disadvantage for a stance (enemy ≥ −frames). */
  curatedPunishers(character, stance, frames) {
    return this.handle()
      .prepare("SELECT * FROM punishers WHERE character = ? AND stance = ? AND enemy >= ? ORDER BY enemy DESC")
      .all(character, stance, -Math.abs(frames));
  }

  hasCuratedPunishers(character) {
    return Boolean(this.handle().prepare("SELECT 1 FROM punishers WHERE character = ? LIMIT 1").get(character));
  }

  children(id) {
    return this.handle().prepare("SELECT * FROM moves WHERE parent = ? ORDER BY num").all(id);
  }

  byTag(character, tag) {
    return this.handle()
      .prepare(`SELECT m.* FROM tags t JOIN moves m ON m.id = t.id WHERE t.character = ? AND t.tag = ? ORDER BY m.num`)
      .all(character, tag);
  }

  /** Keys of this character's moves, for nearest-match suggestions. */
  keys(character) {
    return this.handle().prepare("SELECT id, key, name, target FROM moves WHERE character = ? ORDER BY num").all(character);
  }
}
