// Tekken notation normalisation shared by the index builder and the resolver.
//
// strictKey keeps separators, so "1,2" and "1+2" stay distinct.
// looseKey drops them, so "312" / "3 1 2" / "3,1,2" all collide — the resolver
// treats several loose hits as ambiguous and lets the model choose.

const WORD_SYNONYMS = [
  [/\bwhile\s*stand(ing)?\b|\bwhile\s*rising\b/g, "ws"],
  [/\bfull\s*crouch(ing)?\b|\bcrouch(ing)?\b/g, "fc"],
  [/\bside\s*step\b|\bsidestep\b/g, "ss"],
  [/\bback\s*turn(ed)?\b|\bbackturn(ed)?\b/g, "bt"],
  [/\bheat\b/g, "h"],
  [/\brage\b/g, "r"],
  [/\bdown\s*forward\b/g, "df"],
  [/\bdown\s*back\b/g, "db"],
  [/\bup\s*forward\b/g, "uf"],
  [/\bup\s*back\b/g, "ub"],
];

/** Light cleanup of a user-typed move: lowercase, synonyms, u/f → uf, digits split by spaces → commas. */
export function canonicalQuery(raw) {
  let s = String(raw ?? "").toLowerCase().trim();
  s = s.replace(/[，、]/g, ",").replace(/[＋]/g, "+");
  for (const [re, to] of WORD_SYNONYMS) s = s.replace(re, to);
  s = s.replace(/\b([udfb])\s*\/\s*([udfb])\b/g, "$1$2"); // d/f → df
  // "3 1 2" → "3,1,2" (only between button groups)
  s = s.replace(/(\d)\s+(?=\d)/g, "$1,");
  return s;
}

export function strictKey(raw) {
  return canonicalQuery(raw).replace(/[\s./_]/g, "");
}

export function looseKey(raw) {
  return strictKey(raw).replace(/[^a-z0-9*:~]/g, "");
}

/** Move key inside a Wavu id: "Fahkumram-3,1,2" → "3,1,2" (character may contain '-'). */
export function moveKeyFromId(id, character) {
  const prefix = `${character}-`;
  const key = id.startsWith(prefix) ? id.slice(prefix.length) : id;
  // Wavu template artifact in some ids: "f,n,d,df${justFrame}2" means the just-frame input "f,n,d,df:2"
  return key.replace(/\$\{justFrame\}/g, ":");
}
