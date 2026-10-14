// Telegram HTML rendering (parse_mode: "HTML"). Everything user-visible is escaped here.
import { blockText, cleanInline, listText, noteItems } from "./format.js";
import { prettyKey, stanceTable } from "./stances.js";

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const b = (s) => `<b>${esc(s)}</b>`;
export const i = (s) => `<i>${esc(s)}</i>`;
export const code = (s) => `<code>${esc(s)}</code>`;
/** Move key in readable form: stance/prefix abbreviations spelled out ("SSH.3" → "Senshin 3"). */
export const mk = (character, key) => code(prettyKey(character, key));
/** Collapsed quote: Telegram shows ~3 lines with a tap-to-expand affordance. */
export const details = (html) => (html ? `<blockquote expandable>${html}</blockquote>` : "");
export const quote = (html) => (html ? `<blockquote>${html}</blockquote>` : "");
export const spoiler = (html) => `<tg-spoiler>${html}</tg-spoiler>`;

/** HTML → plain text (gateway fallback path, model tool output, tests). */
export function toPlain(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:b|i|u|s|code|pre|tg-spoiler|blockquote)[^>]*>/gi, "")
    .replace(/<a [^>]*>|<\/a>/gi, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Minimal well-formedness check for Telegram (balanced allowed tags). */
export function isWellFormed(html) {
  const stack = [];
  for (const m of String(html).matchAll(/<(\/?)(b|i|u|s|code|pre|tg-spoiler|blockquote|a)\b[^>]*>/gi)) {
    const tag = m[2].toLowerCase();
    if (!m[1]) stack.push(tag);
    else if (stack.pop() !== tag) return false;
  }
  return stack.length === 0 && !/<(?!\/?(?:b|i|u|s|code|pre|tg-spoiler|blockquote|a)\b)/i.test(html);
}

const dash = (v) => cleanInline(v) || "—";
const parts = (v) => cleanInline(v).split(",").map((p) => p.trim()).filter(Boolean);

/**
 * Compact card (A5): header, one frames row, one level/damage row, details collapsed.
 * @param {{character: string, key: string, chain: object[], extra?: string}} p
 */
export function cardHtml({ character, key, chain, combo = null }) {
  const move = chain[chain.length - 1];
  const levels = chain.flatMap((m) => parts(m.target)).join(", ") || "—";
  const damage = chain.flatMap((m) => parts(m.damage)).join(", ") || "—";
  const startup = chain.map((m) => cleanInline(m.startup)).filter(Boolean).join(", ") || "—";
  const name = move.name ? ` — ${esc(listText(move.name, " / "))}` : "";
  const lines = [
    `🤹🏻 ${b(character)} · ${mk(character, key)}${name}`,
    `⏱ startup ${b(startup)} · 🟦 block ${b(blockText(move.block) || "—")} · 🟥 hit ${esc(dash(move.hit))} · ⚡ CH ${esc(dash(move.ch))}`,
    `🎯 level ${esc(levels)} · 💥 dmg ${esc(damage)}`,
  ];
  const more = [];
  // how to get into the stance(s) this move starts from: "Senshin: f+1+2"
  const stances = stanceTable(character);
  for (const abbr of [...new Set([...String(key).matchAll(/(?:^|[,.])([A-Z]{2,5})\./g)].map((m) => m[1]))]) {
    if (stances[abbr]?.input) more.push(`🧭 ${esc(stances[abbr].name)}: ${code(stances[abbr].input)}`);
  }
  if (combo?.total) more.push(`🚀 combo ${combo.total}${combo.totalHeat && combo.totalHeat > combo.total ? ` · with Heat ${combo.totalHeat}` : ""}${combo.hard ? " · ⚠️ hard route" : ""}`);
  const crush = listText(move.crush, ", ");
  if (crush) more.push(`🛡 crush ${esc(crush)}`);
  const recv = cleanInline(move.recv);
  const tot = cleanInline(move.tot);
  if (recv || tot) more.push(`↩ ${[recv && `recovery ${esc(recv)}`, tot && `total ${esc(tot)}`].filter(Boolean).join(" · ")}`);
  for (const n of noteItems(move.notes)) more.push(`🗒 ${esc(n)}`);
  return [...lines, details(more.join("\n"))].filter(Boolean).join("\n");
}

/** Section helper: bold title + lines; long bodies collapse. */
export function section(title, lines, { collapseOver = 8 } = {}) {
  const body = lines.join("\n");
  if (!lines.length) return b(title);
  return lines.length > collapseOver ? `${b(title)}\n${details(body)}` : `${b(title)}\n${body}`;
}

/** !legend — every symbol the bot uses. */
export const LEGEND_HTML = [
  `📖 ${b("Legend")}`,
  b("Cards"),
  "⏱ startup (i13 = hits on frame 13) · 🟦 on block · 🟥 on hit · ⚡ on counter hit",
  "🎯 hit level (h high · m mid · l low · t throw; capital = also hits grounded; ! = unblockable) · 💥 damage",
  "🛡 crush (js jump/low crush · cs crouch/high crush · pc power crush, with frames) · ↩ recovery / total frames · 🗒 notes",
  "On hit/block suffixes: a launch · d knockdown · c crouching · g guard · s stagger · (+30) = advantage after the combo starter",
  b("Punish / matchup"),
  "⭐ best reliable punish (community pick, easy input) · 💪 more damage but harder · 🚀 launches",
  "⚠️ hard input at this window · 🟡 just-frame / precise input · 🔥 needs Heat or Rage · ≈ motion input not confirmed bufferable",
  "➕ also launches = fits the window in frame data but isn't a community pick (may lack range — unverified)",
  "combo = full combo damage · mini = mini-combo · (computed) = from frame data, no community pick",
  b("Gaps / evasion"),
  "✅ natural combo · ⚡ combo only on counter hit · 🔒 jails · ✋ interruptible · ⏳ delayable",
  "↺ homing · ⬅ tracks left (step right) · ➡ tracks right (step left) · 👣 SSL/SSR whiffs vs sidestep left/right · SWL/SWR sidewalk · 🦆 duckable",
].join("\n");
