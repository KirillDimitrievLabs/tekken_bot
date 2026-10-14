// SQLite index built from the git snapshots (node:sqlite, no dependencies).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { looseKey, moveKeyFromId, strictKey } from "./notation.js";

const SCHEMA = `
CREATE TABLE characters (name TEXT PRIMARY KEY, lname TEXT NOT NULL, moves INTEGER NOT NULL);
CREATE TABLE moves (
  id TEXT PRIMARY KEY, character TEXT NOT NULL, key TEXT NOT NULL, num INTEGER,
  name TEXT, input TEXT, alias TEXT, alt TEXT, parent TEXT,
  target TEXT, damage TEXT, startup TEXT, recv TEXT, tot TEXT, crush TEXT,
  block TEXT, hit TEXT, ch TEXT, notes TEXT
);
CREATE TABLE move_keys (character TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, strict TEXT NOT NULL, loose TEXT NOT NULL);
CREATE INDEX move_keys_strict ON move_keys (character, strict);
CREATE INDEX move_keys_loose ON move_keys (character, loose);
CREATE VIRTUAL TABLE moves_fts USING fts5(id UNINDEXED, character UNINDEXED, text, tokenize='trigram');
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
`;

const COLUMNS = ["id", "character", "key", "num", "name", "input", "alias", "alt", "parent",
  "target", "damage", "startup", "recv", "tot", "crush", "block", "hit", "ch", "notes"];

/** Alternative inputs listed in Wavu's alias/alt fields (comma- or semicolon-separated ids/inputs). */
function altKeys(value, character) {
  if (!value) return [];
  return String(value).split(/[;\n]/).map((v) => moveKeyFromId(v.trim(), character)).filter(Boolean);
}

/** Build the index atomically: write to a temp file, then rename over dbPath. */
export function buildDatabase(dbPath, snapshots, meta = {}) {
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
    db.exec("BEGIN");
    let total = 0;
    for (const [character, moves] of snapshots) {
      insChar.run(character, character.toLowerCase(), moves.length);
      for (const m of moves) {
        const key = moveKeyFromId(m.id, character);
        insMove.run(m.id, character, key, m.num === null ? null : Number(m.num), m.name, m.input, m.alias, m.alt, m.parent,
          m.target, m.damage, m.startup, m.recv, m.tot, m.crush, m.block, m.hit, m.ch, m.notes);
        const keys = [["id", key], ...altKeys(m.alias, character).map((k) => ["alias", k]), ...altKeys(m.alt, character).map((k) => ["alt", k])];
        for (const [kind, k] of keys) insKey.run(character, m.id, kind, strictKey(k), looseKey(k));
        insFts.run(m.id, character, [key, m.name, m.alias, m.alt].filter(Boolean).join(" | "));
        total++;
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

  /** Trigram full-text search over key/name/alias (needs ≥ 3 chars). */
  search(character, text, limit = 8) {
    const q = String(text).replace(/"/g, " ").trim();
    if (q.length < 3) return [];
    return this.handle()
      .prepare(`SELECT m.* FROM moves_fts f JOIN moves m ON m.id = f.id
                WHERE moves_fts MATCH ? AND f.character = ? ORDER BY rank LIMIT ?`)
      .all(`text : "${q}"`, character, limit);
  }

  /** Keys of this character's moves, for nearest-match suggestions. */
  keys(character) {
    return this.handle().prepare("SELECT id, key, name, target FROM moves WHERE character = ? ORDER BY num").all(character);
  }
}
