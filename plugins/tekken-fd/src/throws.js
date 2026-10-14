// B5: !throws <char> — every throw with its break.
import { stanceOf } from "./frames.js";
import { cleanInline, listText } from "./format.js";
import { b, code, mk, details, esc } from "./render.js";

const BREAK = { "1": "1", "2": "2", "1+2": "1+2", "1 or 2": "1 or 2", none: "unbreakable" };

export function throwMoves(index, character) {
  return index.where(character, "throw = 1 AND root = 1");
}

export function formatThrows(index, character) {
  const moves = throwMoves(index, character);
  if (!moves.length) return `🤼 ${b(character)}: no throws in data`;
  const row = (m) => {
    const brk = m.throw_break ? BREAK[m.throw_break] ?? m.throw_break : "?";
    const name = m.name ? ` — ${esc(listText(m.name, " / "))}` : "";
    return `${mk(m.character, m.key)}${name} · break ${b(brk)} · ${esc(cleanInline(m.damage) || "?")} dmg${m.startup ? ` · ${esc(cleanInline(m.startup))}` : ""}`;
  };
  const standard = moves.filter((m) => stanceOf(m.key) === "standing");
  const situational = moves.filter((m) => stanceOf(m.key) !== "standing");
  const capped = (list, n) => [...list.slice(0, n).map(row), ...(list.length > n ? [`…and ${list.length - n} more`] : [])];
  const out = [`🤼 ${b(`${character} — throws (${moves.length})`)}`, b(`Standing (${standard.length})`)];
  const std = capped(standard, 25);
  out.push(std.length > 12 ? details(std.join("\n")) : std.join("\n") || "none");
  if (situational.length) out.push(b(`Situational / stance / OTG (${situational.length})`), details(capped(situational, 20).join("\n")));
  return out.join("\n");
}
