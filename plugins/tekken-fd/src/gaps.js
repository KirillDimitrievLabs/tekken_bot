// B2: !gaps — string interrupts, jails and natural combos, parsed from Wavu notes.
import { cleanInline, noteItems } from "./format.js";
import { b, code, details, esc } from "./render.js";

const ORD = { "1st": 1, first: 1, "2nd": 2, second: 2, "3rd": 3, third: 3, "4th": 4, fourth: 4, "5th": 5, "6th": 6 };

/** Structured facts from one string continuation's notes. */
export function gapFacts(move) {
  const f = { interrupt: null, jail: null, comboHit: null, comboCh: null, delay: null, inputDelay: null };
  for (const n of noteItems(move.notes)) {
    let m;
    if ((m = n.match(/interrupt(?:ible)? with i(\d+)(?:~\d+)? from (\w+) (block|attack|hit)/i))) f.interrupt = { frames: Number(m[1]), from: ORD[m[2].toLowerCase()] ?? m[2], on: m[3].toLowerCase() };
    else if ((m = n.match(/^jails?(?: from (\w+) (block|attack))?(?: with (\S+) delay)?/i))) f.jail = { from: m[1] ? ORD[m[1].toLowerCase()] ?? m[1] : null, delay: m[3] ?? null };
    else if ((m = n.match(/combos? from (?:the )?(\w+) (CH|hit)(?: or (\w+) (CH|hit))?(?: with (\S+) delay)?/i))) {
      const parts = [[m[1], m[2]], [m[3], m[4]]].filter(([a]) => a);
      for (const [ord, kind] of parts) {
        const entry = { from: ORD[ord.toLowerCase()] ?? ord, delay: m[5] ?? null };
        if (kind.toLowerCase() === "ch") f.comboCh ??= entry;
        else f.comboHit ??= entry;
      }
    } else if ((m = n.match(/^move can be delayed by (\S+)/i))) f.delay = m[1];
    else if ((m = n.match(/^input can be delayed by (\S+)/i))) f.inputDelay = m[1];
  }
  return f;
}

const ordTxt = (x) => (typeof x === "number" ? ["", "1st", "2nd", "3rd", "4th", "5th", "6th"][x] ?? `${x}th` : x);

function hitLine(m, f) {
  const bits = [];
  if (f.comboHit) bits.push(`✅ combo from ${ordTxt(f.comboHit.from)} hit${f.comboHit.delay ? ` (${esc(f.comboHit.delay)} delay)` : ""}`);
  else if (f.comboCh) bits.push(`⚡ combo only on ${ordTxt(f.comboCh.from)} CH`);
  if (f.jail) bits.push(`🔒 jails${f.jail.from ? ` from ${ordTxt(f.jail.from)} block` : ""}`);
  if (f.interrupt) bits.push(`✋ interrupt i${f.interrupt.frames} from ${ordTxt(f.interrupt.from)} ${f.interrupt.on}`);
  if (f.delay) bits.push(`⏳ delayable ${esc(f.delay)}`);
  if (!bits.length) bits.push("<i>no gap data</i>");
  return `${code(m.key)} ${esc(cleanInline(m.target).replace(/^,/, ""))} · ${bits.join(" · ")}`;
}

/** One string, hit by hit (chain root → move). */
export function formatString(index, character, move) {
  const chain = index.chain(move.id);
  const lines = [`🧩 ${b(`${character} ${move.key} — gaps`)}`, `${code(chain[0].key)} ${esc(cleanInline(chain[0].target))} · starter ${esc(cleanInline(chain[0].startup))}`];
  for (const m of chain.slice(1)) lines.push(hitLine(m, gapFacts(m)));
  // also show the continuations from here, if any
  const kids = index.children(move.id);
  if (kids.length) lines.push(b("continues with:"), kids.map((k) => hitLine(k, gapFacts(k))).join("\n"));
  return lines.join("\n");
}

/** All exploitable strings: interruptible gaps ≥ i10 (fastest to exploit first), then CH-only follow-ups. */
export function formatCharacterGaps(index, character, cap = 40) {
  const strings = index.where(character, "root = 0");
  const gaps = [];
  const chOnly = [];
  for (const m of strings) {
    const f = gapFacts(m);
    if (f.interrupt && f.interrupt.frames >= 10) gaps.push({ m, f });
    else if (f.comboCh && !f.comboHit && !f.jail) chOnly.push({ m, f });
  }
  gaps.sort((x, y) => y.f.interrupt.frames - x.f.interrupt.frames);
  const g = gaps.slice(0, cap).map(({ m, f }) => `${code(m.key)} ✋ i${f.interrupt.frames} from ${ordTxt(f.interrupt.from)} ${f.interrupt.on}`);
  const c = chOnly.slice(0, cap).map(({ m }) => code(m.key)).join(" · ");
  return [
    `🧩 ${b(`${character} — string gaps`)}`,
    b(`✋ Interruptible (i10+ gap): ${gaps.length}`), gaps.length ? (g.length > 10 ? details(g.join("\n")) : g.join("\n")) : "none",
    b(`⚡ Natural only on CH (duck/interrupt on normal hit): ${chOnly.length}`), chOnly.length ? details(c) : "none",
    "<i>Details for one string: !gaps &lt;char&gt; &lt;string&gt;</i>",
  ].join("\n");
}
