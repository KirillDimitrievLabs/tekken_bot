// B1: !mu <A> vs <B> — for each of B's punishable moves, A's best punish.
import { hitLevelOf, levelClass } from "./frames.js";
import { cleanInline } from "./format.js";
import { bestPunishFor, minus, PUNISH_LEGEND } from "./queries.js";
import { b, code, details, esc } from "./render.js";

/** Best single punish for a move at its block value (low → A is crouching); curated ⭐ first. */
export function bestPunish(index, a, move) {
  const stance = levelClass(hitLevelOf(move.target)) === "low" ? "crouching" : "standing";
  const p = bestPunishFor(index, a, stance, Math.abs(move.block_n));
  return p ? { ...p, stance } : null;
}

export function formatMatchup(index, a, bChar, threshold = -10) {
  const moves = index.unsafeMoves(bChar, threshold);
  const launch = [];
  const damage = [];
  const none = [];
  for (const m of moves) {
    const p = bestPunish(index, a, m);
    const left = `${code(m.key)} ${esc(cleanInline(m.block))}${p?.stance === "crouching" ? " <i>(low)</i>" : ""}`;
    if (!p) none.push(left);
    else (p.launcher ? launch : damage).push(`${left} → ${code(p.key)}${p.startup ? ` i${p.startup}` : ""} · ${p.damage}${p.combo ? " combo" : ""}${p.launcher ? " 🚀" : ""}${p.curated ? " ⭐" : ""}`);
  }
  const block = (title, rows) => (rows.length ? [b(title), rows.length > 10 ? details(rows.join("\n")) : rows.join("\n")] : []);
  return [
    `⚔️ ${b(`${a} vs ${bChar} — punish sheet`)} <i>(${bChar}'s moves at ${minus(threshold)} or worse)</i>`,
    ...block(`🚀 Launch punish (${launch.length})`, launch),
    ...block(`💥 Damage punish (${damage.length})`, damage),
    ...block(`❌ No punish fast enough (${none.length})`, none.length ? [none.join(" · ")] : []),
    moves.length ? "" : `${bChar} has nothing at ${minus(threshold)} or worse.`,
    `<i>⭐ = ${esc(a)}'s community-picked punish (Wavu), otherwise computed from frame data.</i>`,
    PUNISH_LEGEND,
  ].filter((x) => x !== "").join("\n");
}
