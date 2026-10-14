// Per-character JSON snapshots committed to git — the source of truth for the SQLite index.
import fs from "node:fs";
import path from "node:path";

const META_FILE = "_meta.json";

export function snapshotFileName(character) {
  return `${character.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
}

function sortMoves(moves) {
  const num = (m) => (m.num === null ? Number.MAX_SAFE_INTEGER : Number(m.num));
  return [...moves].sort((a, b) => num(a) - num(b) || a.id.localeCompare(b.id));
}

function serialize(character, moves) {
  return `${JSON.stringify({ character, game: "T8", source: "wavu.wiki", moves: sortMoves(moves) }, null, 2)}\n`;
}

/** Read all snapshots: Map<character, moves[]>. */
export function readSnapshots(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".json") || file === META_FILE) continue;
    const doc = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    out.set(doc.character, doc.moves);
  }
  return out;
}

export function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, META_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** Per-character added/removed/changed move ids between two snapshot maps. */
export function diffSnapshots(before, after) {
  const changes = [];
  for (const character of new Set([...before.keys(), ...after.keys()])) {
    const oldById = new Map((before.get(character) ?? []).map((m) => [m.id, JSON.stringify(m)]));
    const newById = new Map((after.get(character) ?? []).map((m) => [m.id, JSON.stringify(m)]));
    let added = 0, removed = 0, changed = 0;
    for (const [id, value] of newById) {
      if (!oldById.has(id)) added++;
      else if (oldById.get(id) !== value) changed++;
    }
    for (const id of oldById.keys()) if (!newById.has(id)) removed++;
    if (added || removed || changed) changes.push({ character, added, removed, changed });
  }
  return changes.sort((a, b) => a.character.localeCompare(b.character));
}

/**
 * Guard against writing a partial/broken fetch over good data.
 * Throws with a human-readable reason.
 */
export function assertPlausible(before, after, { minRows = 4000 } = {}) {
  const total = [...after.values()].reduce((n, m) => n + m.length, 0);
  if (total < minRows) throw new Error(`fetched only ${total} moves (expected ≥ ${minRows}); keeping current data`);
  for (const [character, oldMoves] of before) {
    const now = after.get(character)?.length ?? 0;
    if (oldMoves.length >= 20 && now < oldMoves.length * 0.5) {
      throw new Error(`${character} dropped from ${oldMoves.length} to ${now} moves; keeping current data (use force to override)`);
    }
  }
}

/** Write snapshots + meta; removes files for characters no longer present. */
export function writeSnapshots(dir, byCharacter, meta) {
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set([META_FILE]);
  for (const [character, moves] of byCharacter) {
    const file = snapshotFileName(character);
    keep.add(file);
    fs.writeFileSync(path.join(dir, file), serialize(character, moves));
  }
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith(".json") && !keep.has(file)) fs.rmSync(path.join(dir, file));
  }
  fs.writeFileSync(path.join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
}
