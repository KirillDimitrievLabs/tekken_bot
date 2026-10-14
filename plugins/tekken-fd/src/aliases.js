// Character aliases: curated (plugin/aliases.json) + admin-added (repo data/aliases.json, one git commit each).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9а-яё]/g, "");

export function normalizeAlias(text) {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export class AliasStore {
  /** @param {{curatedPath: string, addedPath: string, repoDir: string}} p */
  constructor({ curatedPath, addedPath, repoDir }) {
    this.curatedPath = curatedPath;
    this.addedPath = addedPath;
    this.repoDir = repoDir;
    this.cache = null;
    this.mtime = null;
  }

  /** nickname → character, admin-added entries override curated ones. */
  all() {
    const mtime = fs.statSync(this.addedPath, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (!this.cache || mtime !== this.mtime) {
      const ru = this.curatedPath.replace(/aliases\.json$/, "aliases.ru.json");
      this.cache = { ...readJson(this.curatedPath), ...readJson(ru), ...readJson(this.addedPath) };
      this.mtime = mtime;
    }
    return this.cache;
  }

  /**
   * Exact character match (canonical name or known alias) — no fuzzy matching, for admin input.
   * @returns {string|null}
   */
  exactCharacter(text, characters) {
    const q = norm(text);
    if (!q) return null;
    const byName = characters.find((c) => norm(c) === q);
    if (byName) return byName;
    const hit = Object.entries(this.all()).find(([k]) => norm(k) === q);
    return hit && characters.includes(hit[1]) ? hit[1] : null;
  }

  /**
   * Add an alias, write data/aliases.json and commit it.
   * @returns {Promise<{alias: string, character: string, previous?: string, commit: string}>}
   */
  async add(aliasText, character, characters, { by = "admin" } = {}) {
    const alias = normalizeAlias(aliasText);
    if (!alias || alias.length > 30) throw new Error("alias must be 1–30 characters");
    if (!characters.includes(character)) throw new Error(`unknown character "${character}"`);
    const clash = characters.find((c) => norm(c) === norm(alias));
    if (clash && clash !== character) throw new Error(`"${alias}" is already the name of ${clash}`);

    const added = readJson(this.addedPath);
    const previous = this.all()[alias];
    added[alias] = character;
    const sorted = Object.fromEntries(Object.entries(added).sort(([a], [b]) => a.localeCompare(b)));
    fs.mkdirSync(path.dirname(this.addedPath), { recursive: true });
    fs.writeFileSync(this.addedPath, `${JSON.stringify(sorted, null, 2)}\n`);
    this.cache = null;

    const rel = path.relative(this.repoDir, this.addedPath);
    const git = (...args) => run("git", ["-C", this.repoDir, ...args]);
    await git("add", "--", rel);
    await git("commit", "--quiet", "-m", `aliases: ${alias} → ${character}`, "-m", `Added by ${by} via Telegram.`);
    const commit = (await git("rev-parse", "--short", "HEAD")).stdout.trim();
    return { alias, character, previous, commit };
  }
}

/**
 * Admin's reply to an "unknown character" request.
 *   "Fahkumram"            → alias = the unknown word from the request
 *   "fahkie = Fahkumram"   (also →, ->, :, " - ")
 *   "fahkie Fahkumram"     (trailing words that are an exact character name)
 * @returns {{alias: string, character: string}|{error: string}}
 */
export function parseAliasReply(text, pendingAlias, store, characters) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return { error: "empty reply" };
  const whole = store.exactCharacter(t, characters);
  if (whole) return { alias: pendingAlias, character: whole };
  const sep = t.match(/^(.+?)\s*(?:=|→|->|:|\s-\s|\s—\s)\s*(.+)$/);
  if (sep) {
    const character = store.exactCharacter(sep[2], characters);
    return character ? { alias: sep[1], character } : { error: `"${sep[2]}" is not an exact character name` };
  }
  const words = t.split(" ");
  for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
    const character = store.exactCharacter(words.slice(-n).join(" "), characters);
    if (character) return { alias: words.slice(0, -n).join(" "), character };
  }
  return { error: `"${t}" is not an exact character name` };
}
