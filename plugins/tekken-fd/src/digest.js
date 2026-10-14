// Patch digest: frame-number changes between two snapshot maps (notes-only edits are ignored).
import { cleanInline, listText } from "./format.js";
import { moveKeyFromId } from "./notation.js";

const FIELDS = [
  ["startup", "startup"], ["block", "block"], ["hit", "hit"], ["ch", "CH"],
  ["damage", "damage"], ["target", "hit level"], ["crush", "crush"],
];
const show = (field, v) => (field === "crush" ? listText(v, ", ") : cleanInline(v)) || "—";

/**
 * @returns {{changes: {character, key, field, from, to}[], added: Record<string, string[]>, removed: Record<string, string[]>}}
 */
export function diffFrames(before, after) {
  const changes = [];
  const added = {};
  const removed = {};
  for (const character of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const oldById = new Map((before.get(character) ?? []).map((m) => [m.id, m]));
    const newById = new Map((after.get(character) ?? []).map((m) => [m.id, m]));
    for (const [id, m] of newById) {
      const o = oldById.get(id);
      if (!o) {
        (added[character] ??= []).push(moveKeyFromId(id, character));
        continue;
      }
      for (const [field, label] of FIELDS) {
        const from = show(field, o[field]);
        const to = show(field, m[field]);
        if (from !== to) changes.push({ character, key: moveKeyFromId(id, character), field: label, from, to });
      }
    }
    for (const id of oldById.keys()) if (!newById.has(id)) (removed[character] ??= []).push(moveKeyFromId(id, character));
  }
  return { changes, added, removed };
}

export function hasFrameChanges(d) {
  return d.changes.length > 0 || Object.keys(d.added).length > 0 || Object.keys(d.removed).length > 0;
}

/** Telegram-ready digest text, capped at `cap` lines. */
export function formatDigest(d, { date = new Date().toISOString().slice(0, 10), cap = 40 } = {}) {
  const lines = [];
  for (const c of d.changes) lines.push(`${c.character} ${c.key}: ${c.field} ${c.from} → ${c.to}`);
  for (const [ch, keys] of Object.entries(d.added)) lines.push(`🆕 ${ch}: ${keys.length} new move(s): ${keys.slice(0, 6).join(" · ")}${keys.length > 6 ? " …" : ""}`);
  for (const [ch, keys] of Object.entries(d.removed)) lines.push(`🗑 ${ch}: ${keys.length} removed: ${keys.slice(0, 6).join(" · ")}${keys.length > 6 ? " …" : ""}`);
  const shown = lines.slice(0, cap);
  if (lines.length > cap) shown.push(`…and ${lines.length - cap} more changes`);
  return [`📢 Frame data update (${date})`, ...shown].join("\n");
}
