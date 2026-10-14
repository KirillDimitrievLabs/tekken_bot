// Telegram HTML rendering (parse_mode: "HTML"). Everything user-visible is escaped here.
import { blockText, cleanInline, listText, noteItems } from "./format.js";

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const b = (s) => `<b>${esc(s)}</b>`;
export const i = (s) => `<i>${esc(s)}</i>`;
export const code = (s) => `<code>${esc(s)}</code>`;
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
export function cardHtml({ character, key, chain }) {
  const move = chain[chain.length - 1];
  const levels = chain.flatMap((m) => parts(m.target)).join(", ") || "—";
  const damage = chain.flatMap((m) => parts(m.damage)).join(", ") || "—";
  const startup = chain.map((m) => cleanInline(m.startup)).filter(Boolean).join(", ") || "—";
  const name = move.name ? ` — ${esc(listText(move.name, " / "))}` : "";
  const lines = [
    `🤹🏻 ${b(character)} · ${code(key)}${name}`,
    `⏱ ${b(startup)}   🟦 ${b(blockText(move.block) || "—")}   🟥 ${esc(dash(move.hit))}   ⚡ ${esc(dash(move.ch))}`,
    `🎯 ${esc(levels)}   💥 ${esc(damage)}`,
  ];
  const more = [];
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
