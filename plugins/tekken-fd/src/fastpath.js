// Deterministic fast path for "!fd <character> <move>": answers clear queries without the model.
// Anything it can't resolve exactly returns null and goes to the fd agent (model reasoning).
import { resolveCharacter, resolveMove } from "./resolve.js";

const TRIGGER = /^\s*(?:@\w+\s+)?!fd\b\s*(.*)$/is;

/** "!fd devil jin ws2" → "devil jin ws2"; null if not an !fd message. */
export function parseTrigger(text) {
  const m = TRIGGER.exec(String(text ?? ""));
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Split "<character words> <move>" trying the longest character prefix first.
 * Multi-word prefixes must be an exact name or nickname ("devil jin", "armor king");
 * a single word may be fuzzy ("fahk", "kazuyaa").
 * @returns {{character: string, move: string}|null}
 */
export function splitQuery(args, characters, aliases) {
  const words = args.split(" ").filter(Boolean);
  const exact = new Set([...characters.map(norm), ...Object.keys(aliases).map(norm)]);
  for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
    const charText = words.slice(0, n).join(" ");
    if (n > 1 && !exact.has(norm(charText))) continue;
    const who = resolveCharacter(charText, characters, aliases);
    if (who.match) return { character: who.match, move: words.slice(n).join(" ") };
  }
  return null;
}

/**
 * @returns {{move: object}|null} an exact match to answer directly, or null to defer to the model.
 */
export function fastResolve(index, text, aliases) {
  const args = parseTrigger(text);
  if (!args) return null;
  const split = splitQuery(args, index.characters().map((c) => c.name), aliases);
  if (!split || !split.move) return null;
  const res = resolveMove(index, split.character, split.move);
  return res.status === "match" ? { move: res.move } : null;
}
