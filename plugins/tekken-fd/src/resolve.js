// Deterministic resolution of (character, move) text to Wavu move ids.
import { resolveNickname } from "./nicknames.js";
import { looseKey, strictKey } from "./notation.js";

/** Optimal-string-alignment distance: edits plus adjacent swaps ("byron" → "bryan" = 2). */
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9а-яё]/g, "");

/**
 * @param {string} text user text ("fahk", "Devil Jin", "jack8")
 * @param {string[]} characters canonical names
 * @param {Record<string,string>} aliases nickname → canonical
 * @returns {{match: string|null, candidates: string[]}}
 */
export function resolveCharacter(text, characters, aliases = {}) {
  const q = norm(text);
  if (!q) return { match: null, candidates: [] };
  const byNorm = new Map(characters.map((c) => [norm(c), c]));
  if (byNorm.has(q)) return { match: byNorm.get(q), candidates: [] };
  const alias = Object.entries(aliases).find(([k]) => norm(k) === q);
  if (alias && characters.includes(alias[1])) return { match: alias[1], candidates: [] };
  const prefixed = characters.filter((c) => norm(c).startsWith(q));
  if (prefixed.length === 1 && q.length >= 3) return { match: prefixed[0], candidates: [] };
  const scored = characters
    .map((c) => ({ c, d: editDistance(q, norm(c)) }))
    .sort((a, b) => a.d - b.d);
  const best = scored[0];
  if (best && best.d <= (q.length >= 6 ? 2 : 1) && (scored[1]?.d ?? 99) > best.d) return { match: best.c, candidates: [] };
  const candidates = [...new Set([...prefixed, ...scored.filter((s) => s.d <= 3).map((s) => s.c)])].slice(0, 6);
  return { match: null, candidates };
}

/**
 * @param {import('./db.js').MoveIndex} index
 * @returns {{status: 'match'|'ambiguous'|'none', move?: object, candidates: object[]}}
 */
export function resolveMove(index, character, text, moveAliases = null) {
  const raw = String(text ?? "").trim();
  if (!raw) return { status: "none", candidates: [] };

  const strict = index.byKey(character, "strict", strictKey(raw));
  if (strict.length === 1) return { status: "match", move: strict[0], candidates: [] };
  if (strict.length > 1) {
    // e.g. Wavu alias "Hellsweep" sits on several strings of f,n,d,DF+4: the archetype picks the move itself
    const nick = resolveNickname(index, character, raw, moveAliases);
    if (nick?.status === "match") return { status: "match", move: nick.move, candidates: [] };
    return { status: "ambiguous", candidates: strict.slice(0, 8) };
  }

  const named = index.byName(character, raw);
  if (named.length === 1) return { status: "match", move: named[0], candidates: [] };

  const nick = resolveNickname(index, character, raw, moveAliases);
  if (nick?.status === "match") return { status: "match", move: nick.move, candidates: [] };
  if (nick?.status === "ambiguous") return { status: "ambiguous", candidates: nick.candidates };

  const loose = index.byKey(character, "loose", looseKey(raw));
  if (loose.length === 1) return { status: "match", move: loose[0], candidates: [] };
  if (loose.length > 1) return { status: "ambiguous", candidates: loose.slice(0, 8) };

  const seen = new Set();
  const related = [...index.containsLoose(character, looseKey(raw)), ...index.search(character, raw, 8)]
    .filter((m) => !seen.has(m.id) && seen.add(m.id))
    .slice(0, 8);
  // fuzzy hits are never auto-posted: the model confirms (hybrid resolution)
  return { status: related.length ? "ambiguous" : "none", candidates: related.length ? related : nearestByKey(index, character, raw) };
}

/** Closest move keys by edit distance on the loose key (for "did you mean"). */
export function nearestByKey(index, character, text, limit = 6) {
  const q = looseKey(text);
  return index
    .keys(character)
    .map((m) => ({ ...m, d: editDistance(q, looseKey(m.key)) }))
    .filter((m) => m.d <= Math.max(2, Math.floor(q.length / 2)))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit);
}
