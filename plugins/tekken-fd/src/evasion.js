// B3: !ss (sidestep/tracking) and !beat (what beats this move) — limited by Wavu's sparse tracking data.
import { hitLevelOf, levelClass, stanceOf } from "./frames.js";
import { cleanInline, listText } from "./format.js";
import { punishOptions, pickOptions, optionLine } from "./queries.js";
import { b, code, mk, details, esc } from "./render.js";
import { prettyKey } from "./stances.js";

const TRACKING_NOTE = "<i>Not every move is annotated — “no data” ≠ linear.</i>";

function tracking(tags) {
  const parts = [];
  if (tags.includes("homing")) parts.push("↺ homing (tracks both)");
  else {
    const l = tags.includes("tracksleft");
    const r = tags.includes("tracksright");
    if (l && r) parts.push("↔ tracks both sides");
    else if (l) parts.push("⬅ tracks left → step right");
    else if (r) parts.push("➡ tracks right → step left");
  }
  const steps = ["ssl", "ssr", "swl", "swr"].filter((t) => tags.includes(t)).map((t) => t.toUpperCase());
  if (steps.length) parts.push(`👣 whiffs vs ${steps.join("/")}`);
  if (tags.includes("duckable")) parts.push("🦆 duckable");
  return parts.length ? parts.join(" · ") : null;
}

/** Key neutral moves: standing roots that are launchers, lows, plus-on-block or quick mids. */
export function formatSidestep(index, character, cap = 40) {
  const roots = index.where(character, "root = 1 AND throw = 0 AND startup_n IS NOT NULL AND startup_n <= 25");
  const known = [];
  const unknown = [];
  for (const m of roots) {
    if (stanceOf(m.key) !== "standing") continue;
    const tags = index.tagsOf(m.id);
    const t = tracking(tags);
    if (t) known.push(`${mk(m.character, m.key)} ${esc(cleanInline(m.target))} · ${t}`);
    else if (tags.some((x) => ["launcher", "low", "plus", "powercrush"].includes(x))) unknown.push(mk(m.character, m.key));
  }
  // strings: Wavu "Whiffs vs SSR from 1st block" sits on the follow-up — step after blocking the first hit
  const steppable = { ssl: [], ssr: [], both: [] };
  for (const m of index.where(character, "root = 0")) {
    const tags = index.tagsOf(m.id);
    const l = tags.includes("ssl");
    const r = tags.includes("ssr");
    if (l && r) steppable.both.push(mk(m.character, m.key));
    else if (r) steppable.ssr.push(mk(m.character, m.key));
    else if (l) steppable.ssl.push(mk(m.character, m.key));
  }
  const stepLine = (label, list) => (list.length ? [`${label} (${list.length})`, list.length > 12 ? details(list.join(" · ")) : list.join(" · ")] : []);
  return [
    `👣 ${b(`${character} — sidestep / tracking`)}`,
    b(`Single moves with tracking info (${known.length})`), known.length ? (known.length > 10 ? details(known.slice(0, cap).join("\n")) : known.join("\n")) : "none",
    b("Strings you can step after blocking the 1st hit"),
    ...stepLine("➡ step right (SSR)", steppable.ssr), ...stepLine("⬅ step left (SSL)", steppable.ssl), ...stepLine("↔ either side", steppable.both),
    ...(steppable.ssr.length + steppable.ssl.length + steppable.both.length ? [] : ["none annotated"]),
    b(`Key moves without tracking data (${unknown.length})`), unknown.length ? details(unknown.slice(0, cap).join(" · ")) : "none",
    TRACKING_NOTE,
  ].join("\n");
}

const crushLines = (index, a, tag, label) => {
  const moves = index.byTag(a, tag).filter((m) => m.root === 1).slice(0, 8);
  return moves.length ? [b(label), moves.map((m) => `${mk(m.character, m.key)} ${esc(listText(m.crush, ", "))} · ${esc(cleanInline(m.startup))}`).join("\n")] : [];
};

/** !beat <B> <move> [as A]: what A can do against B's move. */
export function formatBeat(index, a, target) {
  const level = levelClass(hitLevelOf(target.target));
  const tags = index.tagsOf(target.id);
  const lines = [`🛡 ${b(`${a} vs ${target.character} ${prettyKey(target.character, target.key)}`)} — ${esc(cleanInline(target.target))} · ${esc(cleanInline(target.startup))} · block ${esc(cleanInline(target.block) || "—")}`];
  const t = tracking(tags);
  lines.push(t ?? "👣 sidestep: no tracking data");
  if (level === "high") lines.push("🦆 duck it", ...crushLines(index, a, "highcrush", "High crush (cs)"));
  if (level === "low") {
    lines.push("🧱 block low, then punish:", ...crushLines(index, a, "lowcrush", "Low crush / jump (js)"));
    if (target.block_n !== null && target.block_n <= -10) {
      const opts = pickOptions(punishOptions(index, a, "crouching", Math.abs(target.block_n)), 3);
      if (opts.length) lines.push(b(`Punish ${esc(cleanInline(target.block))} (crouching)`), opts.map(optionLine).join("\n"));
    }
  }
  if (level === "mid") lines.push(...crushLines(index, a, "powercrush", "Power crush (absorbs)"));
  if (level !== "low" && target.block_n !== null && target.block_n <= -10) {
    const opts = pickOptions(punishOptions(index, a, "standing", Math.abs(target.block_n)), 3);
    if (opts.length) lines.push(b(`Punish ${esc(cleanInline(target.block))} on block`), opts.map(optionLine).join("\n"));
  }
  if (!t) lines.push(TRACKING_NOTE);
  return lines.join("\n");
}
