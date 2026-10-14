// !punish / !unsafe / !list / !heat / !wall — deterministic answers (Telegram HTML).
import { damageOf, hitLevelOf, isLauncher, levelClass } from "./frames.js";
import { cleanInline, listText, noteItems } from "./format.js";
import { b, code, details, esc } from "./render.js";
import { COMBO_FROM_FIRST, FILTER_LABELS, FILTERS, resolveFilter } from "./tags.js";

export const minus = (n) => (n < 0 ? `−${Math.abs(n)}` : n > 0 ? `+${n}` : "0");

/**
 * Root moves plus 2-hit strings that combo from the 1st hit, usable from `stance` with startup ≤ frames.
 * @returns {{key, startup, note, damage, launcher}[]} best first: launchers, then damage, then speed
 */
export function punishOptions(index, character, stance, frames) {
  // real attacks only: first hit high/mid/low (no parries "r(m)", throws, specials) and some damage
  const roots = index.punishCandidates(character, stance, frames)
    .filter((r) => ["high", "mid", "low"].includes(levelClass(hitLevelOf(r.target))) && damageOf(r.damage) > 0);
  const options = [];
  for (const r of roots) {
    options.push({ key: r.key, startup: r.startup_eff, note: r.timing_note, damage: damageOf(r.damage), launcher: isLauncher(r.hit) });
    for (const c of index.children(r.id)) {
      if (!noteItems(c.notes).some((n) => COMBO_FROM_FIRST.test(n))) continue;
      options.push({ key: c.key, startup: r.startup_eff, note: r.timing_note, damage: damageOf(r.damage) + damageOf(c.damage), launcher: isLauncher(c.hit) });
    }
  }
  return options.sort((a, b2) => Number(b2.launcher) - Number(a.launcher) || b2.damage - a.damage || a.startup - b2.startup);
}

/** A readable set: the fastest option, then best by launcher/damage, without duplicates. */
export function pickOptions(options, limit = 6) {
  if (!options.length) return [];
  const fastest = [...options].sort((a, b2) => a.startup - b2.startup || b2.damage - a.damage)[0];
  const out = [fastest];
  for (const o of options) {
    if (out.length >= limit) break;
    if (!out.some((x) => x.key === o.key)) out.push(o);
  }
  return out.sort((a, b2) => a.startup - b2.startup || b2.damage - a.damage);
}

const showNote = (o) => (o.note && o.note !== "(bufferable)" ? ` <i>${esc(o.note)}</i>` : "");
export const optionLine = (o) => `i${o.startup} ${code(o.key)} — ${o.damage} dmg${o.launcher ? " 🚀" : ""}${showNote(o)}`;

// ---- curated punishers (Wavu "<Character> punishers"): optimal choice per window

export const PUNISH_LEGEND = "<i>⭐ best reliable punish · 💪 more damage but harder/conditional · 🚀 launches · ⚠️ hard input at this window · 🟡 just-frame / precise · 🔥 needs Heat/Rage · combo = full combo damage · mini = mini-combo · !legend for all symbols</i>";

const isJustFrame = (key) => /:/.test(String(key));
/** Full-motion startup for wind-god-fist-type inputs (f,n,d,df…): listed startup + 3 (just frame) / + 4. */
function fullMotion(index, e) {
  const m = e.move_id ? index.move(e.move_id) : null;
  if (!m?.startup_n || !/^f,n,(?:d,)?df[+:]/i.test(e.key)) return null;
  return m.startup_n + (isJustFrame(e.key) ? 3 : 4);
}

/** Damage value of a curated entry: full combo > mini-combo > listed damage > the string's own damage. */
export function entryValue(index, e) {
  if (e.staple) return { value: e.staple, kind: "combo" };
  if (e.mini) return { value: e.mini, kind: "mini" };
  if (e.damage) return { value: e.damage, kind: "dmg" };
  const m = e.move_id ? index.move(e.move_id) : null;
  return { value: m ? index.chain(m.id).reduce((a, x) => a + damageOf(x.damage), 0) : null, kind: "dmg" };
}

/** Execution at a given window: "hard" | "precise" | "jf" | null. */
export function execution(index, e, frames) {
  if (/^(?:H|R)\./.test(e.key)) return "resource"; // Heat smash / heat-only / Rage art: not always available
  const full = fullMotion(index, e);
  if (e.hard || (full && frames < full)) return "hard";
  if (full && frames === full) return "precise";
  return isJustFrame(e.key) ? "jf" : null;
}

/**
 * Curated options at `frames` for a stance, annotated; plus the optimal (⭐) and max-damage (💪) picks.
 * @returns {null | {rows: object[], best: object|null, max: object|null}}
 */
export function curatedOptions(index, character, stance, frames) {
  const entries = index.curatedPunishers(character, stance, frames);
  if (!entries.length) return null;
  const rows = entries.map((e) => {
    const m = e.move_id ? index.move(e.move_id) : null;
    const launch = m ? Boolean(m.launcher) || index.children(m.id).some((c) => c.launcher && noteItems(c.notes).some((n) => COMBO_FROM_FIRST.test(n))) : false;
    return { ...e, ...entryValue(index, e), exec: execution(index, e, frames), launch: launch || e.kind === "combo" || Boolean(e.staple) };
  }).sort((a, b2) => b2.enemy - a.enemy || (b2.value ?? 0) - (a.value ?? 0));
  const reliable = rows.filter((r) => !r.exec && r.value != null);
  const best = reliable.sort((a, b2) => b2.value - a.value || b2.enemy - a.enemy)[0] ?? null;
  const any = rows.filter((r) => r.value != null).sort((a, b2) => b2.value - a.value)[0] ?? null;
  const max = any && best && any.value > best.value && any !== best ? any : (!best ? any : null);
  return { rows, best, max };
}

const EXEC = { hard: " ⚠️ hard", precise: " 🟡 precise", jf: " 🟡 just-frame", resource: " 🔥 needs Heat/Rage" };
function curatedLine(r, best) {
  const val = r.value != null ? ` · ${r.value}${r.kind === "combo" ? " combo" : r.kind === "mini" ? " mini" : ""}` : "";
  return `${minus(r.enemy)} ${code(r.key)}${val}${r.launch ? " 🚀" : ""}${EXEC[r.exec] ?? ""}${best && r === best ? " ⭐" : ""}`;
}

function stanceBlock(index, character, stance, frames, title) {
  const cur = curatedOptions(index, character, stance, frames);
  if (cur) {
    // launchers in the frame data that fit this window but aren't community picks (may whiff/lack range — unverified)
    const picked = new Set(cur.rows.map((r) => r.key));
    const extra = punishOptions(index, character, stance, frames)
      .filter((o) => o.launcher && !picked.has(o.key) && !cur.rows.some((r) => r.launch && -r.enemy <= o.startup))
      .slice(0, 3);
    const also = extra.length ? [`➕ <i>also launches (frame data, not a community pick):</i> ${extra.map((o) => `${code(o.key)} i${o.startup}`).join(" · ")}`] : [];
    return { lines: [title, ...cur.rows.map((r) => curatedLine(r, cur.best)), ...also], best: cur.best, max: cur.max, curated: true };
  }
  const opts = pickOptions(punishOptions(index, character, stance, frames));
  return { lines: [`${title} <i>(computed)</i>`, ...(opts.length ? opts.map(optionLine) : ["none that fast"])], best: null, max: null, curated: false };
}

export function formatPunish(index, character, frames) {
  const st = stanceBlock(index, character, "standing", frames, `🧍 ${b("standing")}`);
  const cr = stanceBlock(index, character, "crouching", frames, `🧎 ${b("crouching")} <i>(after a blocked low)</i>`);
  const pick = (blk, label) => (blk.best ? `⭐ ${label}: ${code(blk.best.key)} → ${blk.best.value}${blk.best.kind === "combo" ? " combo" : ""}` : null);
  const maxLine = (blk, label) => (blk.max ? `💪 ${label} max: ${code(blk.max.key)} → ${blk.max.value}${blk.max.kind === "combo" ? " combo" : ""}${EXEC[blk.max.exec] ?? ""}` : null);
  return [
    `🥊 ${b(`${character} — punish ${minus(-frames)}`)}`,
    pick(st, "standing"), pick(cr, "crouching"), maxLine(st, "standing"), maxLine(cr, "crouching"),
    ...st.lines, ...cr.lines,
    st.curated || cr.curated ? `<i>Source: Wavu “${esc(character)} punishers” (community picks).</i>` : null,
    PUNISH_LEGEND,
  ].filter(Boolean).join("\n");
}

/** Single best punish for a move at `block` frames from a stance (curated ⭐ first, then computed). */
export function bestPunishFor(index, character, stance, frames) {
  const cur = curatedOptions(index, character, stance, frames);
  if (cur?.best) return { key: cur.best.key, startup: null, damage: cur.best.value, combo: cur.best.kind === "combo", launcher: cur.best.launch, exec: null, curated: true, enemy: cur.best.enemy };
  const opts = punishOptions(index, character, stance, frames);
  return opts[0] ? { ...opts[0], combo: false, curated: false } : null;
}

export function formatPunishComputed(index, character, frames) {
  const standing = pickOptions(punishOptions(index, character, "standing", frames));
  const crouching = pickOptions(punishOptions(index, character, "crouching", frames));
  return [
    `🥊 ${b(`${character} — punish ${minus(-frames)}`)}`,
    `🧍 ${b("standing")}`,
    ...(standing.length ? standing.map(optionLine) : ["none that fast"]),
    `🧎 ${b("crouching")} <i>(after a blocked low)</i>`,
    ...(crouching.length ? crouching.map(optionLine) : ["none that fast"]),
    "<i>🚀 launch · ≈ motion input not confirmed bufferable</i>",
  ].join("\n");
}

export function formatUnsafe(index, character, threshold = -10, cap = 60) {
  const moves = index.unsafeMoves(character, threshold);
  if (!moves.length) return `🛡 ${b(character)}: nothing at ${minus(threshold)} or worse on block.`;
  const groups = [
    ["🚀 launch punishable (≤ −15)", (x) => x <= -15],
    ["⚠️ −13 / −14", (x) => x <= -13 && x > -15],
    [`🟨 ${minus(threshold)} … −12`, (x) => x > -13],
  ];
  const lines = [`🩸 ${b(`${character} — unsafe on block (${minus(threshold)} or worse): ${moves.length}`)}`];
  let shown = 0;
  for (const [label, test] of groups) {
    const group = moves.filter((m) => test(m.block_n));
    if (!group.length) continue;
    const part = group.slice(0, Math.max(0, cap - shown));
    shown += part.length;
    const body = part.map((m) => `${code(m.key)} ${esc(cleanInline(m.block))}`).join(" · ")
      + (group.length > part.length ? ` · +${group.length - part.length} more` : "");
    lines.push(b(label), part.length > 12 ? details(body) : body);
  }
  return lines.join("\n");
}

export const moveLine = (m) => {
  const name = m.name ? ` — ${esc(listText(m.name, " / "))}` : "";
  const block = m.block ? ` <i>${esc(cleanInline(m.block))}</i>` : "";
  return `${code(m.key)}${name}${block}`;
};

export function formatList(index, character, tag, cap = 40) {
  const moves = index.byTag(character, tag);
  const label = FILTER_LABELS[tag] ?? tag;
  if (!moves.length) return `📋 ${b(`${character} — ${label}`)}: none`;
  const lines = moves.slice(0, cap).map(moveLine);
  if (moves.length > cap) lines.push(`…and ${moves.length - cap} more`);
  const head = `📋 ${b(`${character} — ${label} (${moves.length})`)}`;
  return lines.length > 10 ? `${head}\n${details(lines.join("\n"))}` : `${head}\n${lines.join("\n")}`;
}

const sec = (title, rows) => (rows.length ? [b(title), rows.length > 8 ? details(rows.join("\n")) : rows.join("\n")] : []);

/** B7: heat sheet — engagers with heat-dash results, smash, burst, heat-only moves. */
export function formatHeat(index, character) {
  const engagers = index.byTag(character, "engager").map((m) => `${moveLine(m)}${m.heat_dash ? ` · dash ${esc(m.heat_dash)}` : ""}`);
  const lines = [
    `🔥 ${b(`${character} — heat`)}`,
    ...sec("Heat engagers", engagers),
    ...sec("Heat smash", index.byTag(character, "smash").map(moveLine)),
    ...sec("Heat burst", index.byTag(character, "burst").map(moveLine)),
    ...sec("Heat-only moves (H.)", index.byTag(character, "heat").filter((m) => m.key !== "H.2+3").map(moveLine)),
  ];
  return lines.length > 1 ? lines.join("\n") : `${lines[0]}\nno heat data`;
}

/** B7: wall sheet — wall crush/splat, balcony and floor breaks. */
export function formatWall(index, character) {
  const splat = index.where(character, "lower(notes) LIKE '%wall splat%' OR lower(notes) LIKE '%wallsplat%' OR lower(notes) LIKE '%wall bounce%'").map(moveLine);
  const lines = [
    `🧱 ${b(`${character} — wall`)}`,
    ...sec("Wall crush", index.byTag(character, "wall").map(moveLine)),
    ...sec("Wall splat / bounce", splat),
    ...sec("Balcony break", index.byTag(character, "balcony").map(moveLine)),
    ...sec("Floor break", index.byTag(character, "floor").map(moveLine)),
  ];
  return lines.length > 1 ? lines.join("\n") : `${lines[0]}\nno wall data`;
}

export function filterHelp() {
  const seen = new Set(Object.values(FILTERS));
  return `Filters: ${[...seen].map((t) => FILTER_LABELS[t] ?? t).join(", ")}`;
}

export { resolveFilter };
