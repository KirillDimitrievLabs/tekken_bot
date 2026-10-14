// Frame-data card in the clan's template. Pure functions — no I/O.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
    const key = e.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return m;
  });
}

/** Wiki/HTML markup → plain text: [[a|b]] → b, [[a]] → a, '''b''' → b, tags removed. */
export function cleanInline(value) {
  if (value === null || value === undefined) return "";
  let s = decodeEntities(value);
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2").replace(/\[\[([^\]]*)\]\]/g, "$1");
  s = s.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, "$1");
  s = s.replace(/'{2,}/g, "");
  s = s.replace(/<[^>]*>/g, "");
  return s.replace(/\s+/g, " ").trim();
}

/** Notes field → list of plain-text bullet items. */
export function noteItems(notes) {
  if (!notes) return [];
  let s = decodeEntities(notes);
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(div|p|li|ul)[^>]*>/gi, "\n");
  return s
    .split("\n")
    .map((line) => cleanInline(line.replace(/^\s*[*#:]+\s*/, "")))
    .filter(Boolean);
}

/** Split a Wavu multi-part field (",h" / "m,m" / "11") into parts, dropping empties. */
function parts(value) {
  return cleanInline(value).split(",").map((p) => p.trim()).filter(Boolean);
}

/**
 * Build the card for `move`, walking `chain` (root → … → move) for string fields.
 * @param {{character:string, key:string, chain:object[]}} input
 */
export function formatCard({ character, key, chain }) {
  const move = chain[chain.length - 1];
  const hitLevels = chain.flatMap((m) => parts(m.target));
  const damage = chain.flatMap((m) => parts(m.damage));
  const startup = chain.map((m) => cleanInline(m.startup)).filter(Boolean);
  const notes = noteItems(move.notes);

  const lines = [
    `🤹🏻 Character: ${character}`,
    `🦾 command: ${key}`,
  ];
  if (move.name) lines.push(`🏷 name: ${cleanInline(move.name)}`);
  lines.push(
    `🤜🏿 hit level: ${hitLevels.join(", ")}`,
    `1️⃣ damage: ${damage.join(", ")}`,
    `ℹ️ startup: ${startup.join(", ")}`,
    `🟦 on block: ${cleanInline(move.block)}`,
    `🟥 on hit: ${cleanInline(move.hit)}`,
    `⚡️ on counter hit: ${cleanInline(move.ch)}`,
  );
  if (move.crush) lines.push(`🛡 crush: ${cleanInline(move.crush)}`);
  lines.push(`📌 Notes: ${notes.length ? "🗒" : "—"}`);
  for (const note of notes) lines.push(`🗒  ${note}`);
  lines.push("— wavu.wiki");
  return lines.join("\n");
}

/** "Did you mean" message for the group. */
export function formatSuggestions({ character, query, candidates }) {
  const head = character ? `❌ Not found: ${character} ${query}` : `❌ Not found: ${query}`;
  if (!candidates?.length) return head;
  return `${head}\nDid you mean: ${candidates.map((c) => c.key ?? c).join(" · ")}`;
}
