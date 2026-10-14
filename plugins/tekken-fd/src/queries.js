// !punish / !unsafe / !list — deterministic answers from the index.
import { damageOf, hitLevelOf, isLauncher, levelClass } from "./frames.js";
import { cleanInline, listText, noteItems } from "./format.js";
import { FILTER_LABELS, FILTERS, resolveFilter } from "./tags.js";

const COMBO_FROM_FIRST = /^combos? from 1st hit\b/i;
const minus = (n) => (n < 0 ? `−${Math.abs(n)}` : n > 0 ? `+${n}` : "0");

/**
 * Root moves plus 2-hit strings that combo from the 1st hit, usable from `stance` with startup ≤ frames.
 * @returns {{key, startup, damage, launcher}[]} best first: launchers, then damage, then speed
 */
export function punishOptions(index, character, stance, frames) {
  // real attacks only: first hit high/mid/low (no parries "r(m)", throws, specials) and some damage
  const roots = index.punishCandidates(character, stance, frames)
    .filter((r) => ["high", "mid", "low"].includes(levelClass(hitLevelOf(r.target))) && damageOf(r.damage) > 0);
  const options = [];
  for (const r of roots) {
    options.push({ key: r.key, startup: r.startup_eff, listed: r.startup_n, damage: damageOf(r.damage), launcher: isLauncher(r.hit) });
    for (const c of index.children(r.id)) {
      if (!noteItems(c.notes).some((n) => COMBO_FROM_FIRST.test(n))) continue;
      options.push({ key: c.key, startup: r.startup_eff, listed: r.startup_n, damage: damageOf(r.damage) + damageOf(c.damage), launcher: isLauncher(c.hit) });
    }
  }
  return options.sort((a, b) => Number(b.launcher) - Number(a.launcher) || b.damage - a.damage || a.startup - b.startup);
}

/** Pick a readable set: the fastest option, then best by launcher/damage, without duplicates. */
function pick(options, limit = 6) {
  if (!options.length) return [];
  const fastest = [...options].sort((a, b) => a.startup - b.startup || b.damage - a.damage)[0];
  const out = [fastest];
  for (const o of options) {
    if (out.length >= limit) break;
    if (!out.some((x) => x.key === o.key)) out.push(o);
  }
  return out.sort((a, b) => a.startup - b.startup || b.damage - a.damage);
}

const optionLine = (o) => `  i${o.startup} ${o.key} — ${o.damage} dmg${o.launcher ? " 🚀" : ""}${o.listed != null && o.listed < o.startup ? ` (i${o.listed} + motion)` : ""}`;

export function formatPunish(index, character, frames) {
  const standing = pick(punishOptions(index, character, "standing", frames));
  const crouching = pick(punishOptions(index, character, "crouching", frames));
  const lines = [`🥊 ${character} — punish ${minus(-frames)}`];
  lines.push("🧍 standing:", ...(standing.length ? standing.map(optionLine) : ["  none that fast"]));
  lines.push("🧎 crouching (after a blocked low):", ...(crouching.length ? crouching.map(optionLine) : ["  none that fast"]));
  lines.push("🚀 = launch punish");
  return lines.join("\n");
}

export function formatUnsafe(index, character, threshold = -10, cap = 45) {
  const moves = index.unsafeMoves(character, threshold);
  if (!moves.length) return `🛡 ${character}: no moves at ${minus(threshold)} or worse on block.`;
  const groups = [
    ["🚀 launch punishable (≤ −15)", (b) => b <= -15],
    ["⚠️ −13 / −14", (b) => b <= -13 && b > -15],
    [`🟨 ${minus(threshold)} … −12`, (b) => b > -13],
  ];
  const lines = [`🩸 ${character} — unsafe on block (${minus(threshold)} or worse): ${moves.length}`];
  let shown = 0;
  for (const [label, test] of groups) {
    const group = moves.filter((m) => test(m.block_n));
    if (!group.length) continue;
    const room = Math.max(0, cap - shown);
    const part = group.slice(0, room);
    shown += part.length;
    lines.push(`${label}:`, `  ${part.map((m) => `${m.key} (${cleanInline(m.block)})`).join(" · ")}${group.length > part.length ? ` · +${group.length - part.length} more` : ""}`);
  }
  return lines.join("\n");
}

export function formatList(index, character, tag, cap = 30) {
  const moves = index.byTag(character, tag);
  const label = FILTER_LABELS[tag] ?? tag;
  if (!moves.length) return `📋 ${character} — ${label}: none`;
  const lines = [`📋 ${character} — ${label} (${moves.length}):`];
  for (const m of moves.slice(0, cap)) {
    const name = m.name ? ` — ${listText(m.name, " / ")}` : "";
    const block = m.block ? ` [${cleanInline(m.block)}]` : "";
    lines.push(`  ${m.key}${name}${block}`);
  }
  if (moves.length > cap) lines.push(`  …and ${moves.length - cap} more`);
  return lines.join("\n");
}

export function filterHelp() {
  const seen = new Set(Object.values(FILTERS));
  return `Filters: ${[...seen].map((t) => FILTER_LABELS[t] ?? t).join(", ")}`;
}

export { resolveFilter };
