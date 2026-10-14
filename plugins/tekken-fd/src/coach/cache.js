import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const cacheKey = ({ mode, as = null, opponent, language, level, dossierHash, tipsHash, promptVersion, model }) =>
  createHash("sha256").update(JSON.stringify([mode, as, opponent, language, level, dossierHash, tipsHash, promptVersion, model])).digest("hex");

/** Private runtime state, separate from the read-only frame index and git snapshots. */
export class CoachCache {
  constructor(file, { now = Date.now, dailyLimit = 5 } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.now = now;
    this.dailyLimit = dailyLimit;
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS coach_cache (key TEXT PRIMARY KEY, html_parts TEXT NOT NULL, json TEXT NOT NULL,
        created_at TEXT NOT NULL, model TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, a TEXT, b TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coach_limits (user_id TEXT NOT NULL, day TEXT NOT NULL, generations INTEGER NOT NULL, PRIMARY KEY(user_id,day));
      CREATE TABLE IF NOT EXISTS coach_users (user_id TEXT PRIMARY KEY, language TEXT NOT NULL, level TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coach_pages (id TEXT PRIMARY KEY, path TEXT NOT NULL, url TEXT NOT NULL, key TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coach_feedback (key TEXT NOT NULL, user_id TEXT NOT NULL, vote INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY(key,user_id));`);
  }
  get(key, { count = true } = {}) {
    const r = this.db.prepare("SELECT * FROM coach_cache WHERE key=?").get(key);
    if (!r) return null;
    if (count) this.db.prepare("UPDATE coach_cache SET hits=hits+1 WHERE key=?").run(key);
    return { ...r, guide: JSON.parse(r.json), parts: JSON.parse(r.html_parts) };
  }
  put(key, { guide, parts, model, as = null, opponent }) {
    const createdAt = new Date(this.now()).toISOString();
    this.db.prepare("INSERT OR REPLACE INTO coach_cache(key,html_parts,json,created_at,model,a,b) VALUES(?,?,?,?,?,?,?)")
      .run(key, JSON.stringify(parts), JSON.stringify(guide), createdAt, model, as, opponent);
    return createdAt;
  }
  invalidate(character = null) {
    if (character) this.db.prepare("DELETE FROM coach_cache WHERE a=? OR b=?").run(character, character);
    else this.db.exec("DELETE FROM coach_cache");
  }
  delete(key) { this.db.prepare("DELETE FROM coach_cache WHERE key=?").run(key); }
  consume(userId) {
    // A stable UTC day is independent of the gateway's operating-system timezone.
    const day = new Date(this.now()).toISOString().slice(0, 10);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const n = this.db.prepare("SELECT generations FROM coach_limits WHERE user_id=? AND day=?").get(String(userId), day)?.generations ?? 0;
      if (n >= this.dailyLimit) { this.db.exec("ROLLBACK"); return false; }
      this.db.prepare("INSERT INTO coach_limits VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET generations=generations+1").run(String(userId), day);
      this.db.prepare("DELETE FROM coach_limits WHERE day<?").run(day);
      this.db.exec("COMMIT");
      return true;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  /** Give back a generation that did not produce a guide (failure, fallback, stale data). */
  refund(userId) {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    this.db.prepare("UPDATE coach_limits SET generations=generations-1 WHERE user_id=? AND day=? AND generations>0").run(String(userId), day);
  }
  preference(userId) {
    return this.db.prepare("SELECT language,level FROM coach_users WHERE user_id=?").get(String(userId)) ?? { language: "en", level: "mid" };
  }
  setPreference(userId, preference) {
    const p = { ...this.preference(userId), ...preference };
    if (!["en", "ru"].includes(p.language) || !["mid", "high"].includes(p.level)) throw new Error("Use en/ru and mid/high.");
    this.db.prepare("INSERT OR REPLACE INTO coach_users VALUES(?,?,?)").run(String(userId), p.language, p.level);
    return p;
  }
  feedback(key, userId, vote) {
    if (!this.get(key, { count: false }) || ![-1, 0, 1].includes(vote)) return false;
    this.db.prepare("INSERT OR REPLACE INTO coach_feedback VALUES(?,?,?,?)").run(key, String(userId), vote, new Date(this.now()).toISOString());
    return true;
  }
  /** telegra.ph page for a guide identity (mode, characters, language, level); edited in place on regeneration. */
  page(id) { return this.db.prepare("SELECT * FROM coach_pages WHERE id=?").get(id) ?? null; }
  setPage(id, { path, url, key }) {
    this.db.prepare("INSERT OR REPLACE INTO coach_pages VALUES(?,?,?,?,?)").run(id, path, url, key, new Date(this.now()).toISOString());
  }
  stats() { return this.db.prepare("SELECT count(*) AS guides,coalesce(sum(hits),0) AS hits FROM coach_cache").get(); }
  close() { this.db.close(); }
}
