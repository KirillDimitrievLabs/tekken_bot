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

const BULLET = /^\s*(?:[*#:]\s*)+/;

/**
 * Notes field → list of plain-text items.
 * Wavu notes are a wiki list ("* item"), wrapped in <div class="plainlist"> or {{Plainlist}},
 * where an item may be a property tag (<div class="movedata-icon …">Balcony Break</div>) and may
 * continue on the next lines. Items are grouped by bullet, never split at tags.
 */
export function noteItems(notes) {
  if (!notes) return [];
  const text = decodeEntities(notes)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "") // tags vanish in place: "<div…>Weapon</div>?" → "Weapon?"
    .replace(/\{\{\s*plainlist\s*\|?/gi, "")
    .replace(/\}\}/g, "");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const hasBullets = lines.some((l) => BULLET.test(l));
  const items = [];
  for (const line of lines) {
    if (!hasBullets || BULLET.test(line)) items.push(line.replace(BULLET, ""));
    else if (items.length) items[items.length - 1] += ` ${line}`; // continuation of the current bullet
    else items.push(line);
  }
  return items.map(cleanInline).filter((it) => it && it !== "?");
}

/**
 * A field that Wavu sometimes stores as a wiki list (crush frames, alternative move names):
 * list → items joined by `sep`; plain value → cleaned text. Leading "," (later hit of a string) dropped.
 */
export function listText(value, sep) {
  if (!value) return "";
  const raw = decodeEntities(value);
  const items = /class="(?:plain|dot)list"|^\s*\*/m.test(raw) ? noteItems(value) : [cleanInline(value)];
  return items.map((it) => it.replace(/^,\s*/, "")).filter(Boolean).join(sep);
}

/** Block value: Wavu writes "!" for moves that can't be blocked (throws, unblockables). */
export function blockText(value) {
  const v = cleanInline(value);
  return v === "!" ? "! (unblockable)" : v;
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
  if (move.name) lines.push(`🏷 name: ${listText(move.name, " / ")}`);
  lines.push(
    `🤜🏿 hit level: ${hitLevels.join(", ")}`,
    `1️⃣ damage: ${damage.join(", ")}`,
    `ℹ️ startup: ${startup.join(", ")}`,
    `🟦 on block: ${blockText(move.block)}`,
    `🟥 on hit: ${cleanInline(move.hit)}`,
    `⚡️ on counter hit: ${cleanInline(move.ch)}`,
  );
  const crush = listText(move.crush, ", ");
  if (crush) lines.push(`🛡 crush: ${crush}`);
  lines.push(notes.length ? "📌 Notes:" : "📌 Notes: —");
  for (const note of notes) lines.push(`🗒  ${note}`);
  return lines.join("\n");
}

/** "Did you mean" message for the group. */
export function formatSuggestions({ character, query, candidates }) {
  const head = character ? `❌ Not found: ${character} ${query}` : `❌ Not found: ${query}`;
  if (!candidates?.length) return head;
  return `${head}\nDid you mean: ${candidates.map((c) => c.key ?? c).join(" · ")}`;
}
