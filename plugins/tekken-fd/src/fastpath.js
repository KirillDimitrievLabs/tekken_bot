// Deterministic handling of "!fd <character> <move>" before any agent/model runs.
import { formatSuggestions } from "./format.js";
import { resolveCharacter, resolveMove } from "./resolve.js";

const TRIGGER = /^\s*(?:@\w+\s+)?!fd\b\s*(.*)$/is;
const HELP_COMMAND = /^\s*\/(start|help)(?:@\w+)?(?:\s|$)/i;

/** "!fd devil jin ws2" → "devil jin ws2"; null if not an !fd message. */
export function parseTrigger(text) {
  const m = TRIGGER.exec(String(text ?? ""));
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

const COMMAND = /^\s*(?:@\w+\s+)?!(fd|punish|unsafe|list)\b\s*(.*)$/is;

/** "!punish kaz -13" → {cmd: "punish", args: "kaz -13"}; null if not a bot command. */
export function parseCommand(text) {
  const m = COMMAND.exec(String(text ?? ""));
  return m ? { cmd: m[1].toLowerCase(), args: m[2].replace(/\s+/g, " ").trim() } : null;
}

/**
 * Character + the rest of the arguments ("kaz -13", "devil jin lows", "jin").
 * @returns {{character: string, rest: string} | {unknown: string, candidates: string[]} | {empty: true}}
 */
export function parseCharacterArgs(args, characters, aliases) {
  if (!args) return { empty: true };
  const split = splitQuery(args, characters, aliases);
  if (split) return { character: split.character, rest: split.move };
  const whole = resolveCharacter(args, characters, aliases);
  if (whole.match) return { character: whole.match, rest: "" };
  const token = args.split(" ")[0];
  return { unknown: token, candidates: resolveCharacter(token, characters, aliases).candidates };
}

export function isHelpCommand(text) {
  return HELP_COMMAND.test(String(text ?? ""));
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
 * Classify an !fd message.
 * @returns {null | {kind: "usage"}
 *   | {kind: "match", move: object}
 *   | {kind: "need_move", character: string}
 *   | {kind: "unknown_character", token: string, args: string, candidates: string[]}
 *   | {kind: "unresolved", character: string, move: string, candidates: object[]}}
 */
export function analyze(index, text, aliases) {
  const args = parseTrigger(text);
  if (args === null) return null;
  if (!args) return { kind: "usage" };
  const characters = index.characters().map((c) => c.name);
  const split = splitQuery(args, characters, aliases);
  if (!split) {
    const whole = resolveCharacter(args, characters, aliases);
    if (whole.match) return { kind: "need_move", character: whole.match };
    const token = args.split(" ")[0];
    return { kind: "unknown_character", token, args, candidates: resolveCharacter(token, characters, aliases).candidates };
  }
  if (!split.move) return { kind: "need_move", character: split.character };
  const res = resolveMove(index, split.character, split.move);
  if (res.status === "match") return { kind: "match", move: res.move };
  return { kind: "unresolved", character: split.character, move: split.move, candidates: res.candidates };
}

/** Back-compat helper: exact match or null. */
export function fastResolve(index, text, aliases) {
  const a = analyze(index, text, aliases);
  return a?.kind === "match" ? { move: a.move } : null;
}

export const USAGE = [
  "!fd <character> <move> — frame data card",
  "   !fd Fahkumram 312 · !fd kaz df1 · !fd devil jin ws2",
  "!punish <character> <frames> — best punishers",
  "   !punish kaz -13",
  "!unsafe <character> [frames] — moves punishable on block",
  "   !unsafe jin · !unsafe jin -13",
  "!list <character> <filter> — e.g. lows, homing, power crush, heat engagers, launchers, tornado",
  "   !list steve lows",
].join("\n");

export function needMoveText(character) {
  return `Which ${character} move? e.g. !fd ${character} df+1`;
}

export function unresolvedText(a) {
  return formatSuggestions({ character: a.character, query: a.move.slice(0, 60), candidates: a.candidates.slice(0, 6) });
}

export function unknownCharacterText(a) {
  const maybe = a.candidates.length ? `\nClosest: ${a.candidates.join(" · ")}` : "";
  return `❓ Unknown character: "${a.token.slice(0, 30)}"${maybe}\nAdmin: reply to this message with the character name to add "${a.token.slice(0, 30).toLowerCase()}" as an alias.`;
}

/** Deterministic text for any non-match (used where no model should improvise). */
export function suggestReply(index, text, aliases) {
  const a = analyze(index, text, aliases);
  if (!a) return null;
  switch (a.kind) {
    case "usage": return USAGE;
    case "need_move": return needMoveText(a.character);
    case "unknown_character": return unknownCharacterText(a);
    case "unresolved": return unresolvedText(a);
    default: return null;
  }
}
