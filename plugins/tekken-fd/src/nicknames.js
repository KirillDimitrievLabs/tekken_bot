// Move nicknames (glossary, Wavu archetypes, admin-added) and Russian keyboard-layout fixes.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { looseKey, strictKey } from "./notation.js";
import { resolveFilter } from "./tags.js";

const run = promisify(execFile);

// Community shorthands → input (same for every character that has the move).
// Sources: Wavu Wiki glossary/Standard move, infil's fighting game glossary, LearnTekken terminology.
export const GLOSSARY = {
  ewgf: "f,n,d,df:2", "electric": "f,n,d,df:2", "electric wind god fist": "f,n,d,df:2", "electric wgf": "f,n,d,df:2",
  wgf: "f,n,d,df+2", "wind god fist": "f,n,d,df+2",
  "wind god step": "f,n,d,df", wgs: "f,n,d,df",
  jab: "1", "jab jab": "1,1", "one two": "1,2", "1-2": "1,2", "one-two": "1,2", "1 2": "1,2",
  "heat burst": "2+3", hb: "2+3", "heat smash": "H.2+3", hs: "H.2+3",
  "rage art": "R.df+1+2", ra: "R.df+1+2",
  "low jab": "d+1", "crouch jab": "d+1", "crouch straight": "d+2", "shin kick": "d+4", "crouch spin kick": "d+3",
  "jumping knuckle": "uf+1", hook: "uf+2", "delayed hopkick": "uf,n,4",
  "back throw": "Back throw", "left throw": "Left throw", "right throw": "Right throw",
};

/** Move alias store: { character: { "ewgf": "f,n,d,df:2", … } }, admin-added, committed to git. */
export class MoveAliasStore {
  constructor({ file, repoDir }) {
    this.file = file;
    this.repoDir = repoDir;
  }

  all() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  get(character, text) {
    const k = normWords(text);
    return this.all()[character]?.[k] ?? null;
  }

  async add(character, aliasText, key, { by = "admin" } = {}) {
    const alias = normWords(aliasText);
    if (!alias || alias.length > 40) throw new Error("move alias must be 1–40 characters");
    const data = this.all();
    data[character] = { ...(data[character] ?? {}), [alias]: key };
    const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))
      .map(([c, m]) => [c, Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)))]));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(sorted, null, 2)}\n`);
    const rel = path.relative(this.repoDir, this.file);
    const git = (...a) => run("git", ["-C", this.repoDir, ...a]);
    await git("add", "--", rel);
    await git("commit", "--quiet", "-m", `move aliases: ${character} ${alias} → ${key}`, "-m", `Added by ${by} via Telegram.`);
    return { character, alias, key, commit: (await git("rev-parse", "--short", "HEAD")).stdout.trim() };
  }
}

export const normWords = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Nickname step of move resolution: admin alias → glossary input → archetype tag.
 * @returns {null | {status: "match", move} | {status: "ambiguous", candidates}}
 */
export function resolveNickname(index, character, text, moveAliases) {
  const q = normWords(text);
  const viaInput = (input) => {
    const hits = index.byKey(character, "strict", strictKey(input));
    const loose = hits.length ? hits : index.byKey(character, "loose", looseKey(input));
    return loose.length === 1 ? { status: "match", move: loose[0] } : loose.length > 1 ? { status: "ambiguous", candidates: loose.slice(0, 8) } : null;
  };
  const admin = moveAliases?.get(character, q);
  if (admin) {
    const r = viaInput(admin);
    if (r) return r;
  }
  if (GLOSSARY[q]) {
    const r = viaInput(GLOSSARY[q]);
    if (r) return r;
  }
  const tag = resolveFilter(q);
  if (tag && /^(?:magicfour|hopkick|orbital|hellsweep|snakeedge|powerlow|shadowcutter|staturekick|clefcannon|slashkick|midcheck)$/.test(tag)) {
    const moves = index.byTag(character, tag);
    if (moves.length === 1) return { status: "match", move: moves[0] };
    if (moves.length > 1) return { status: "ambiguous", candidates: moves.slice(0, 8) };
  }
  return null;
}

// ---- Russian keyboard layout (ЙЦУКЕН → QWERTY), for "!ад кфя вф1" = "!fd kaz df1"
const RU = "йцукенгшщзхъфывапролджэячсмитьбю.ё";
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`";
const LAYOUT = new Map([...RU].map((c, i) => [c, EN[i]]));
for (const [c, i] of [...RU].map((c, i) => [c.toUpperCase(), i])) LAYOUT.set(c, EN[i].toUpperCase());

export const layoutToLatin = (s) => [...String(s)].map((c) => LAYOUT.get(c) ?? c).join("");
const hasCyrillic = (s) => /[а-яё]/i.test(s);

/**
 * "!ад кфя вф1" → "!fd kaz df1". Applies only when the command word is Cyrillic and maps to a known
 * command; tokens that are known Cyrillic character names (aliases.ru.json) are kept as typed.
 */
export function fixLayout(text, commands, cyrillicNames = new Set()) {
  const m = String(text ?? "").match(/^(\s*!)(\S+)([\s\S]*)$/);
  if (!m || !hasCyrillic(m[2])) return text;
  const cmd = layoutToLatin(m[2]).toLowerCase();
  if (!commands.includes(cmd)) return text;
  const rest = m[3].replace(/[^\s;]+/g, (tok) => (cyrillicNames.has(tok.toLowerCase()) || !hasCyrillic(tok) ? tok : layoutToLatin(tok)));
  return `${m[1]}${cmd}${rest}`;
}
