import { resolveCharacter } from "../resolve.js";

/** Character resolution is exact/alias-only; raw free text never becomes a model task. */
export function parseCoachTarget(args, characters, aliases, { tip = false } = {}) {
  let text = String(args ?? "").trim();
  const options = {};
  if (!tip) {
    text = text.replace(/(?:^|\s)--(lang|level)\s+(\S+)/gi, (_, k, v) => { options[k.toLowerCase() === "lang" ? "language" : "level"] = v.toLowerCase(); return " "; }).trim();
    if (options.language && !["en", "ru"].includes(options.language)) return { error: "Language: --lang en or --lang ru." };
    if (options.level && !["mid", "high"].includes(options.level)) return { error: "Level: --level mid or --level high." };
  }
  const parts = text.replace(/^vs\.?\s+/i, "").split(/\s+vs\.?\s+|\s+против\s+/i);
  if (!text || parts.length > 2) return { error: "Use !vs reina or !coach kazuya vs reina. Options: --lang en|ru --level mid|high." };
  const as = parts.length === 2 ? resolveCharacter(parts[0], characters, aliases).match : null;
  const opponent = resolveCharacter(parts.at(-1), characters, aliases).match;
  if (!opponent || (parts.length === 2 && !as)) return { error: "Unknown character. Use a character name or a known nickname." };
  return { as, opponent, ...options };
}

export function parseTip(args, characters, aliases) {
  const m = String(args).match(/^([\s\S]+?)\s*(?:#(defense|punish|neutral|pressure|wall|heat|oki|general))?\s*:\s*([\s\S]+)$/i);
  if (!m) return { error: "Use !tip vs reina #defense: your advice (20–400 characters)." };
  return { ...parseCoachTarget(m[1].trim(), characters, aliases, { tip: true }), category: m[2]?.toLowerCase(), text: m[3].trim() };
}
