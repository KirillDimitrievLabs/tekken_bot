// Deterministic resolution of (character, move) text to Wavu move ids.
import { looseKey, strictKey } from "./notation.js";

export function editDistance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

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
export function resolveMove(index, character, text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { status: "none", candidates: [] };

  const strict = index.byKey(character, "strict", strictKey(raw));
  if (strict.length === 1) return { status: "match", move: strict[0], candidates: [] };
  if (strict.length > 1) return { status: "ambiguous", candidates: strict.slice(0, 8) };

  const named = index.byName(character, raw);
  if (named.length === 1) return { status: "match", move: named[0], candidates: [] };

  const loose = index.byKey(character, "loose", looseKey(raw));
  if (loose.length === 1) return { status: "match", move: loose[0], candidates: [] };
  if (loose.length > 1) return { status: "ambiguous", candidates: loose.slice(0, 8) };

  const fts = index.search(character, raw, 8);
  return { status: fts.length ? "ambiguous" : "none", candidates: fts.length ? fts : nearestByKey(index, character, raw) };
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
