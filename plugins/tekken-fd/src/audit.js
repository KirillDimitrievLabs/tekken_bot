// Detects Wavu markup the formatter doesn't understand yet (new templates, tables, tag layouts),
// by checking the *cleaned* text that cards would show. Run on every sync.
import { blockText, cleanInline, listText, noteItems } from "./format.js";

const FIELDS = ["name", "target", "damage", "startup", "recv", "block", "hit", "ch", "crush"];

// Leftovers that should never survive cleaning. Plain ">" is legit text ("Jab > Uppercut", "11 > 18").
const PATTERNS = [
  ["template", /\{\{|\}\}/],
  ["wiki link", /\[\[|\]\]/],
  ["html tag", /<\/?[a-z!][^>]*>?/i],
  ["html attribute", /\b(?:style|class|colspan|rowspan)\s*=/i],
  ["html entity", /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i],
  ["list/table markup", /^\s*(?:[*#:;]|\{\||\|-|\|\}|!(?! \(unblockable\)$))/],
  ["placeholder", /^\?$/],
];

function classify(text) {
  for (const [kind, re] of PATTERNS) if (re.test(text)) return kind;
  return null;
}

/**
 * @param {Map<string, object[]>} snapshots character → raw Wavu rows
 * @returns {{issues: {id: string, field: string, kind: string, text: string}[], moves: number}}
 */
export function auditSnapshots(snapshots) {
  const issues = [];
  let moves = 0;
  for (const rows of snapshots.values()) {
    for (const m of rows) {
      moves++;
      for (const item of noteItems(m.notes)) {
        const kind = classify(item);
        if (kind) issues.push({ id: m.id, field: "notes", kind, text: item });
      }
      for (const field of FIELDS) {
        if (!m[field]) continue;
        // check exactly what the card renders for this field
        const text = field === "crush" ? listText(m[field], ", ") : field === "name" ? listText(m[field], " / ")
          : field === "block" ? blockText(m[field]) : cleanInline(m[field]);
        const kind = classify(text);
        if (kind) issues.push({ id: m.id, field, kind, text });
      }
    }
  }
  return { issues, moves };
}

/** One-paragraph summary for /fd_sync replies ("" when clean). */
export function summarizeAudit({ issues }, limit = 5) {
  if (!issues.length) return "";
  const byMove = [...new Map(issues.map((i) => [i.id, i])).values()];
  const shown = byMove.slice(0, limit).map((i) => `${i.id} ${i.field}: "${i.text.slice(0, 40)}" (${i.kind})`);
  const more = byMove.length > limit ? `\n…and ${byMove.length - limit} more` : "";
  return `⚠️ ${byMove.length} move(s) have markup the bot can't clean yet — cards will show it as-is:\n${shown.join("\n")}${more}`;
}
