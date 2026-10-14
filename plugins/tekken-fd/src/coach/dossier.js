// Computed facts for the coach. Unknown spacing, crush timing and string gaps stay unknown.
import { createHash } from "node:crypto";
import { cleanInline, noteItems } from "../format.js";
import { damageOf, hitLevelOf, hitLevelsOf, isLauncher, levelClass } from "../frames.js";
import { gapFacts } from "../gaps.js";
import { bestPunishFor } from "../queries.js";
import { strictKey } from "../notation.js";
import { guideCoverage, selectGuides } from "../guides.js";
import { prettyKey, stanceTable } from "../stances.js";

export const DOSSIER_VERSION = "coach-dossier-v2";
const REQUIRED_UNSAFE = 8;
export const DOSSIER_LIMITS = Object.freeze({ rows: 12, characterChars: 42000, counterChars: 160000, matchupChars: 280000, guideChars: 80000 });
const hashOf = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const plain = (v) => cleanInline(v).replace(/[<>]/g, "").slice(0, 260);
const dataText = (v) => String(v).replace(/<\/?data\b/gi, "&lt;data").replace(/[<>]/g, (c) => c === "<" ? "&lt;" : "&gt;");
const attr = (v) => dataText(v).replace(/"/g, "&quot;");
const levelOf = (m) => levelClass(hitLevelOf(m.target));
const blockLevelOf = (m) => levelClass(hitLevelsOf(m.target).at(-1));
const ref = (m) => `[[${m.id}]]`;
const boundFactStrings = (value) => typeof value === "string" ? plain(value).slice(0, 100) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, boundFactStrings(v)])) : value;

/** A stable, limited field set for provenance and hashing; no local/personal metadata. */
function fingerprint(m, fact) {
  return { id: m.id, character: m.character, key: m.key, parent: m.parent, startup: m.startup, startup_eff: m.startup_eff,
    block: m.block, block_n: m.block_n, hit: m.hit, ch: m.ch, target: m.target, damage: m.damage,
    crush: m.crush, notes: m.notes, heat_dash: m.heat_dash, throw_break: m.throw_break, reach_n: m.reach_n,
    tags: fact.tags, combo: fact.combo, chCombo: fact.chCombo };
}

function counterHitCombo(index, id) {
  if (!index.handle) return null;
  const row = index.handle().prepare("SELECT * FROM combos WHERE move_id = ? AND ch = 1 ORDER BY (COALESCE(best, 0) + base) DESC LIMIT 1").get(id);
  if (!row) return null;
  return { ...row, total: row.best == null ? null : row.base + row.best, totalHeat: row.best_heat == null ? null : row.base + row.best_heat };
}

/** Every move row carries source numbers; continuation rows show first-hit timing separately. */
function moveLine(index, m, fact) {
  const root = m.parent ? index.chain(m.id)[0] : m;
  const bits = [ref(m), plain(m.key), `startup ${plain(m.startup) || "unknown"}`, `block ${plain(m.block) || "unknown"}`,
    `hit ${plain(m.hit) || "unknown"}`, `CH ${plain(m.ch) || "unknown"}`, `level ${plain(m.target) || "unknown"}`, `damage ${plain(m.damage) || "unknown"}`];
  if (m.parent && root?.startup) bits.push(`starter ${ref(root)} ${plain(root.startup)}`);
  if (m.startup_eff != null && m.startup_eff !== m.startup_n) bits.push(`effective i${m.startup_eff} ${plain(m.timing_note)}`);
  if (fact.combo?.total != null) bits.push(`normal-hit combo ${fact.combo.total}${fact.combo.hard ? " (hard route)" : ""}`);
  if (fact.combo?.totalHeat != null) bits.push(`Heat combo ${fact.combo.totalHeat}`);
  if (fact.chCombo?.total != null) bits.push(`counter-hit combo ${fact.chCombo.total}${fact.chCombo.hard ? " (hard route)" : ""}`);
  if (isLauncher(m.hit) && fact.combo?.total == null) bits.push("normal-hit combo reward not indexed");
  if (isLauncher(m.ch) && !isLauncher(m.hit) && fact.chCombo?.total == null) bits.push("counter-hit combo reward not indexed");
  if (m.crush) bits.push(`crush ${plain(m.crush)}`);
  if (m.heat_dash) bits.push(`Heat dash ${plain(m.heat_dash)}`);
  if (fact.tags.length) bits.push(`tags ${fact.tags.join(",")}`);
  const notes = noteItems(m.notes).filter((n) => !/combo from|interrupt|jail|delay/i.test(n)).join("; ").slice(0, 150);
  if (notes) bits.push(`notes ${plain(notes)}`);
  return bits.join(" · ");
}

function stringFacts(m, fact) {
  const f = fact.gap;
  const bits = [ref(m), plain(m.key)];
  if (f.comboHit) bits.push(`natural combo from hit ${f.comboHit.from}${f.comboHit.delay ? `, delay ${f.comboHit.delay}` : ""}`);
  else if (f.comboCh) bits.push(`CH combo from hit ${f.comboCh.from}; normal-hit combo status unknown`);
  else bits.push("natural-combo status unknown");
  bits.push(f.jail ? `jails${f.jail.from ? ` from hit ${f.jail.from} block` : ""}${f.jail.delay ? `, delay ${f.jail.delay}` : ""}` : "jail status unknown");
  if (f.interrupt) bits.push(`interrupt with i${f.interrupt.frames} from hit ${f.interrupt.from} ${f.interrupt.on} (tested note, not measured gap)`);
  else bits.push("interrupt/gap unknown");
  if (f.delay) bits.push(`move delay ${f.delay}`);
  if (f.inputDelay) bits.push(`input delay ${f.inputDelay}`);
  const sides = ["ssl", "ssr", "swl", "swr"].filter((t) => fact.tags.includes(t)).map((t) => t.toUpperCase());
  bits.push(sides.length ? `annotated step ${sides.join("/")}; keep note conditions` : "step direction unknown");
  bits.push(fact.tags.includes("duckable") ? "annotated duckable; exact hit/timing must be checked in notes" : "duckability unknown");
  return bits.join(" · ");
}

function punish(index, character, move, all, stance = blockLevelOf(move) === "low" ? "crouching" : "standing", frames = Math.abs(move.block_n)) {
  const p = bestPunishFor(index, character, stance, frames);
  if (!p) return { move: move.id, answer: null, stance, window: frames, curated: false, range: "unverified" };
  const matches = all.filter((m) => m.character === character && strictKey(m.key) === strictKey(p.key));
  const response = matches.length === 1 ? matches[0] : null;
  const root = response ? index.chain(response.id)[0] : null;
  // Curated tables can use nominal timing; their window and execution caveat remain explicit.
  return { move: move.id, answer: response?.id ?? null, stance, window: frames, curated: p.curated,
    startup: p.startup ?? root?.startup_eff ?? null, damage: p.damage, combo: p.combo || Boolean(!p.curated && response && index.comboFor(response.id)?.total === p.damage),
    launcher: p.launcher, timing: root?.timing_note ?? null, range: "unverified" };
}

function punishLine(row) {
  const bits = [`[[${row.move}]]`, `block window ${row.window}`, row.stance];
  if (!row.answer) bits.push(row.universal ? "universal frame window; choose your character's verified punish" : "no indexed response found; use a verified punish in practice mode");
  else {
    bits.push(`→ [[${row.answer}]]`, row.curated ? "curated Wavu choice" : "computed frame candidate");
    if (row.startup != null) bits.push(`effective i${row.startup}`);
    if (row.damage != null) bits.push(`${row.damage} ${row.combo ? "combo damage" : "damage"}`);
    if (row.launcher) bits.push("launcher");
    if (row.timing) bits.push(plain(row.timing));
  }
  bits.push("range/pushback unverified; test reach and timing");
  return bits.join(" · ");
}

/** Build a bounded dossier from indexed facts, command-synced guides and approved tips. */
export function buildDossier(index, { as = null, opponent, language = "ru", level = "high", guides = {}, tips = [] } = {}) {
  if (!opponent) throw new Error("opponent is required");
  const known = new Set(index.characters().map((c) => c.name));
  if (!known.has(opponent) || (as && !known.has(as))) throw new Error("unknown coach character");
  const mode = as ? "matchup" : "counter";
  const characters = as && as !== opponent ? [as, opponent] : [opponent];
  const all = characters.flatMap((c) => index.where(c, "1 = 1"));
  const allMap = new Map(all.map((m) => [m.id, m]));
  const facts = new Map(all.map((m) => [m.id, { tags: index.tagsOf(m.id).sort(), gap: boundFactStrings(gapFacts(m)), combo: index.comboFor(m.id), chCombo: isLauncher(m.ch) ? counterHitCombo(index, m.id) : null }]));
  const approved = tips.filter((t) => ["approved", "needs-review"].includes(t.status) && t.opponent === opponent && (!t.as || t.as === as))
    .sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, 30)
    .map((t) => ({ id: String(t.id), as: t.as ?? null, opponent: t.opponent, category: t.category ?? "general", author: plain(t.author ?? "Clan member"),
      text: String(t.text ?? "").slice(0, 400).replace(/\[\[([^\]]+)\]\]/g, (_, id) => allMap.has(id) ? `[[${id}]]` : id),
      createdAt: t.createdAt ?? "", approvedAt: t.approvedAt ?? "", status: t.status, needsReview: Boolean(t.needsReview || t.status === "needs-review"), votes: Number.isFinite(t.votes) ? t.votes : null }));
  const guideSelection = Object.fromEntries(characters.map((c) => [c, selectGuides(guides, c, { as: c === as, opponent: c === as ? opponent : as,
    moves: allMap, maxChars: DOSSIER_LIMITS.guideChars, withReport: true })]));
  const selected = characters.flatMap((c) => guideSelection[c].sections);
  const keyIds = new Set(selected.filter((s) => /key moves/i.test(s.heading.join(" / "))).flatMap((s) => [...s.text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1])));
  const tipMoveIds = new Set(approved.flatMap((t) => [...t.text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1])));
  const score = (m) => (keyIds.has(m.id) ? 300 : 0) + (tipMoveIds.has(m.id) ? 400 : 0) + (facts.get(m.id).combo ? 80 : 0)
    + (m.launcher ? 40 : 0) + damageOf(m.damage) + (m.startup_eff == null ? 0 : Math.max(0, 30 - m.startup_eff));
  const ranked = (rows) => [...rows].sort((a, b) => score(b) - score(a) || (a.num ?? 9999) - (b.num ?? 9999) || a.id.localeCompare(b.id));
  const byChar = (c) => all.filter((m) => m.character === c);
  const roots = (c) => byChar(c).filter((m) => m.root && !m.throw);
  const tagged = (c, ...tags) => ranked(byChar(c).filter((m) => facts.get(m.id).tags.some((t) => tags.includes(t))));
  const diverseTags = (c, tags, perTag = 2) => [...new Map(tags.flatMap((tag) => tagged(c, tag).slice(0, perTag)).map((m) => [m.id, m])).values()];
  const unsafe = (c) => ranked(index.unsafeMoves(c, -10)).sort((a, b) => Number(keyIds.has(b.id) || tipMoveIds.has(b.id)) - Number(keyIds.has(a.id) || tipMoveIds.has(a.id)) || a.block_n - b.block_n || score(b) - score(a));
  const blocks = [];
  const sections = {};
  const appendBlock = (kind, title, rows, maxChars = 3000) => {
    const cap = rows.slice(0, DOSSIER_LIMITS.rows);
    const lines = [];
    for (const line of cap) {
      if (lines.join("\n").length + line.length > maxChars) break;
      lines.push(line);
    }
    if (!lines.length) lines.push("No indexed facts for this block; do not infer absence of the property.");
    blocks.push(`## ${title}\n${lines.join("\n")}`);
    sections[kind] = { title, rows: lines.length, available: rows.length };
  };
  const meta = index.meta?.() ?? {};
  const dataVersion = `wavu:${meta.syncedAt ?? "unknown"}${meta.tdSyncedAt ? ` td:${meta.tdSyncedAt}` : ""}`;
  const coverageChars = Object.fromEntries(characters.map((c) => [c, guideCoverage(guides[c])]));
  const coverage = { level: coverageChars[opponent].level, characters: coverageChars };
  for (const character of characters) {
    const start = blocks.length;
    const own = byChar(character);
    const r = roots(character);
    const fast = [...r].filter((m) => m.stance === "standing" && m.startup_eff != null).sort((a, b) => a.startup_eff - b.startup_eff || score(b) - score(a));
    const prefix = `${character}:`;
    const show = (m) => moveLine(index, m, facts.get(m.id));
    const stanceNames = [...new Set(own.map((m) => m.key.match(/^([A-Z][A-Za-z]+)\./)?.[1]).filter(Boolean))].sort();
    const identity = [`${character} · indexed moves ${own.length} · stance key prefixes ${stanceNames.join(", ") || "none indexed"}`,
      ...ranked(own.filter((m) => /(?:stance|transition|parry|armor|install)/i.test(noteItems(m.notes).join(" ")))).slice(0, 11).map(show)];
    appendBlock(`${prefix}identity`, "Identity and indexed mechanics", identity);
    // Stances with names, entry inputs and their most important moves (readable names in brackets).
    const stanceRows = Object.entries(stanceTable(character)).map(([abbr, st]) => {
      const moves = ranked(own.filter((m) => new RegExp(`(?:^|[,.])${abbr}\\.`).test(m.key))).slice(0, 6);
      return moves.length ? `${st.name} (${abbr})${st.input ? ` · entry ${plain(st.input)}` : ""} · ${moves.length} key moves: ${moves.map((m) => `${ref(m)} ${plain(prettyKey(character, m.key))}`).join(", ")}` : null;
    }).filter(Boolean);
    appendBlock(`${prefix}stances`, "Stances", stanceRows, 4000);
    const fastPicks = [fast[0], fast.find((m) => levelOf(m) === "mid"), fast.find((m) => levelOf(m) === "low"), ...fast.filter((m) => m.startup_eff <= 12)].filter(Boolean);
    appendBlock(`${prefix}fast`, "Fast standing buttons / mids / lows", [...new Map(fastPicks.map((m) => [m.id, m])).values()].map(show));
    appendBlock(`${prefix}plus`, "Plus frames / pressure", ranked(r.filter((m) => m.block_n >= 1)).map(show));
    appendBlock(`${prefix}launchers`, "Launchers and counter-hit launchers", ranked(own.filter((m) => isLauncher(m.hit) || isLauncher(m.ch))).map(show));
    appendBlock(`${prefix}unsafe`, "Unsafe moves (opponent's view)", unsafe(character).map((m) => `${show(m)} · punish window ${Math.abs(m.block_n)} · ${blockLevelOf(m) === "low" ? "crouching" : "standing"}; range unknown`), 5000);
    appendBlock(`${prefix}lows`, "Lows", tagged(character, "low").map((m) => `${show(m)} · ${m.block_n != null && m.block_n <= -10 ? `crouching punish window ${Math.abs(m.block_n)}` : "no guaranteed frame punish window"}; launch punish depends on the responding character and reach`));
    appendBlock(`${prefix}strings`, "Strings (combo / jail / interrupt / step / duck)", ranked(own.filter((m) => !m.root)).map((m) => stringFacts(m, facts.get(m.id))));
    appendBlock(`${prefix}evasion`, "Evasion and crush / homing / tornado", diverseTags(character, ["powercrush", "highcrush", "lowcrush", "homing", "tornado"]).map(show));
    appendBlock(`${prefix}heat`, "Heat", diverseTags(character, ["smash", "burst", "engager", "heatdash", "heat"]).map(show), 5000);
    appendBlock(`${prefix}wall`, "Wall (splat / carry / breaks)", ranked(own.filter((m) => /wall splat|wallsplat|wall bounce|wall carry|balcony break|floor break|wall crush/i.test(noteItems(m.notes).join(" ")))).map(show));
    appendBlock(`${prefix}throws`, "Throws and indexed breaks", ranked(own.filter((m) => m.throw)).map((m) => `${show(m)} · break ${m.throw_break ?? "unknown"}`));
    appendBlock(`${prefix}damage`, "Punish reward by window", [10, 12, 13, 14, 15].flatMap((window) => ["standing", "crouching"].map((stance) => {
      const p = punish(index, character, { id: `${character}-window`, block_n: -window }, all, stance, window);
      return punishLine(p).replace(`[[${character}-window]]`, `window ${window}`);
    })));
    const body = blocks.splice(start).join("\n\n");
    blocks.push(`<data kind="dossier" character="${attr(character)}" version="${attr(dataVersion)}" coverage="${coverageChars[character].level}">\n${body}\n</data>`);
  }

  const bUnsafe = unsafe(opponent).slice(0, DOSSIER_LIMITS.rows);
  const requiredUnsafe = bUnsafe.slice(0, REQUIRED_UNSAFE).map((m) => as ? punish(index, as, m, all) : {
    move: m.id, answer: null, stance: blockLevelOf(m) === "low" ? "crouching" : "standing", window: Math.abs(m.block_n), curated: false, range: "unverified", universal: true });
  const escapeAnswers = [];
  // Lows with an unknown block value have no established answer beyond "block low"; skip them as required escapes.
  for (const m of tagged(opponent, "low").filter((m) => m.root && m.block_n != null).slice(0, 6)) {
    const p = as && m.block_n != null && m.block_n <= -10 ? punish(index, as, m, all) : null;
    escapeAnswers.push({ move: m.id, kind: "low", answer: p?.answer ?? null, actions: ["crouch_block", ...(m.block_n != null && m.block_n <= -10 ? ["punish"] : [])],
      ...(m.block_n != null && m.block_n <= -10 ? { window: Math.abs(m.block_n) } : {}), facts: { level: "low", punish: p } });
  }
  for (const m of ranked(byChar(opponent).filter((m) => !m.root))) {
    if (escapeAnswers.filter((e) => e.kind === "string").length >= 6) break;
    const fact = facts.get(m.id), gap = fact.gap;
    const sides = ["ssl", "ssr", "swl", "swr"].filter((t) => fact.tags.includes(t)).map((t) => t.toUpperCase());
    const actions = [...sides, ...(fact.tags.includes("duckable") ? ["duck"] : []), ...(gap.interrupt?.on === "block" ? ["interrupt"] : [])];
    if (!actions.length) continue;
    let answer = null;
    if (as && gap.interrupt?.on === "block") {
      const candidate = roots(as).filter((x) => x.stance === "standing" && ["mid", "high"].includes(levelOf(x)) && x.startup_eff != null && x.startup_eff <= gap.interrupt.frames)
        .sort((a, b) => a.startup_eff - b.startup_eff || score(b) - score(a))[0];
      answer = candidate?.id ?? null;
    }
    escapeAnswers.push({ move: m.id, kind: "string", answer, actions, facts: { gap, tags: fact.tags }, window: gap.interrupt?.frames });
  }
  const interactions = {};
  if (as) {
    const launchFast = (c, stance = "standing") => roots(c).filter((m) => m.stance === stance && isLauncher(m.hit) && m.startup_eff != null).sort((a, b) => a.startup_eff - b.startup_eff)[0];
    const fastest = (c, type) => roots(c).filter((m) => m.stance === "standing" && levelOf(m) === type && m.startup_eff != null).sort((a, b) => a.startup_eff - b.startup_eff)[0];
    interactions.I1 = bUnsafe.map((m) => punish(index, as, m, all));
    interactions.I2 = unsafe(as).slice(0, DOSSIER_LIMITS.rows).map((m) => punish(index, opponent, m, all));
    interactions.I3 = escapeAnswers.filter((e) => e.kind === "string");
    interactions.I4 = escapeAnswers.filter((e) => e.kind === "low");
    interactions.I5 = tagged(opponent, "plus").slice(0, 12).map((m) => ({ move: m.id, plus: m.block_n, fastest: fastest(as, "high")?.id ?? null,
      note: "plus value alone does not establish a frame trap; opponent follow-up, spacing, sidestep and armor timing are unknown" }));
    interactions.I6 = [opponent, as].flatMap((c) => tagged(c, "homing", "ssl", "ssr", "swl", "swr").slice(0, 6).map((m) => ({ move: m.id, tags: facts.get(m.id).tags,
      note: "step only where annotated; unannotated moves are not proven linear; preserve note conditions" })));
    interactions.I7 = [opponent, as].flatMap((c) => tagged(c, "powercrush").slice(0, 6).map((m) => ({ move: m.id, versus: c === as ? opponent : as,
      pokes: ranked(roots(c === as ? opponent : as).filter((m) => ["high", "mid"].includes(levelOf(m)) && m.startup_eff <= 15)).slice(0, 3).map((m) => m.id),
      crush: plain(m.crush), note: "armor startup/end and recovery must be checked; absorption against a particular poke is not guaranteed" })));
    interactions.I8 = [as, opponent].map((c) => ({ character: c, launcher: launchFast(c)?.id ?? null, crouchingLauncher: launchFast(c, "crouching")?.id ?? null, low: fastest(c, "low")?.id ?? null, mid: fastest(c, "mid")?.id ?? null,
      note: "startup comparison only; no priority claim without advantage and range" }));
    interactions.I9 = [as, opponent].flatMap((c) => tagged(c, "engager", "smash", "burst", "heatdash").slice(0, 6).map((m) => ({ move: m.id, heatDash: m.heat_dash,
      note: "Heat dash safety cannot be inferred for unindexed follow-ups or spacing" })));
    interactions.I10 = [opponent, as].flatMap((c) => tagged(c, "highcrush", "lowcrush").slice(0, 6).map((m) => ({ move: m.id, crush: plain(m.crush), tags: facts.get(m.id).tags,
      against: ranked(roots(c === as ? opponent : as).filter((other) => (facts.get(m.id).tags.includes("highcrush") && levelOf(other) === "high") || (facts.get(m.id).tags.includes("lowcrush") && levelOf(other) === "low"))).slice(0, 3).map((m) => m.id),
      versus: c === as ? opponent : as, note: "level interaction conditional on active crush frames and timing; no guaranteed evasion" })));
    const titles = { I1: `${opponent} unsafe → ${as} punish`, I2: `${as} unsafe → ${opponent} punish`, I3: "Strings: evidence-backed escape candidates", I4: "Lows: crouching block and punishment",
      I5: "Plus frames vs fastest response", I6: "Homing and annotated stepping", I7: "Power crush vs pokes (timing conditional)", I8: "Speed comparison", I9: "Both Heat toolkits", I10: "Crushes vs hit levels (timing conditional)" };
    const formatted = Object.entries(interactions).map(([id, rows]) => {
      const lines = rows.map((r) => {
        if (id === "I1" || id === "I2") return punishLine(r);
        const convertRefs = (value) => typeof value === "string" && allMap.has(value) ? `[[${value}]]` : Array.isArray(value) ? value.map(convertRefs) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convertRefs(v)])) : value;
        const moved = convertRefs(r);
        return JSON.stringify(moved);
      });
      sections[id] = { title: titles[id], rows: rows.length, available: rows.length };
      return `## ${id}: ${titles[id]}\n${lines.join("\n") || "No indexed facts; unknown."}`;
    });
    blocks.push(`<data kind="interactions" as="${attr(as)}" opponent="${attr(opponent)}">\n${formatted.join("\n\n")}\n</data>`);
  }
  // Required facts survive source budgets and are explicit for both modes.
  blocks.push(`<data kind="required-answers">\n## Priority unsafe moves\n${requiredUnsafe.map(punishLine).join("\n")}\n## Evidence-backed low/string escapes\n${escapeAnswers.map((e) => `[[${e.move}]] · ${e.kind} · actions ${e.actions.join(",")} · ${e.answer ? `response candidate [[${e.answer}]] · ` : ""}${e.window != null ? `window ${e.window} · ` : ""}${e.kind === "string" ? stringFacts(allMap.get(e.move), facts.get(e.move)) : e.actions.includes("punish") ? "crouch block, then crouching punish within the window" : "SAFE on block: crouch block only; do not claim any punish"}`).join("\n")}\n</data>`);
  // Full rows are tracked after category caps, so every extra source-linked move gets current facts.
  const fullFactIds = new Set([...blocks.join("\n").matchAll(/^\[\[([^\]]+)\]\][^\n]* · startup /gm)].map((m) => m[1]));
  // Source blocks are independently bounded; neither Wavu prose nor tips can close the data delimiter.
  for (const s of selected) blocks.push(`<data kind="wavu-guide" source-kind="${s.kind}" page="${attr(s.page)}" id="${attr(s.id)}" license="CC BY-SA 4.0">\n${dataText(s.text)}\n</data>`);
  if (approved.length) blocks.push(`<data kind="clan-tips" subject="${attr(as ? `${as} vs ${opponent}` : `vs ${opponent}`)}">\n${approved.map((t) => `[tip ${t.id} · ${t.author} · ${t.createdAt.slice(0, 10)}${t.votes == null ? "" : ` · votes ${t.votes}`}${t.needsReview ? " · may be outdated" : ""}] ${dataText(t.text)}`).join("\n")}\n</data>`);
  const updateReferencedFacts = () => {
    const oldAppendix = blocks.findIndex((b) => b.startsWith('<data kind="referenced-moves"'));
    if (oldAppendix >= 0) blocks.splice(oldAppendix, 1);
    for (const key of Object.keys(sections)) if (key.startsWith("source-facts:")) delete sections[key];
    const sourceIds = new Set([...blocks.filter((b) => b.startsWith('<data kind="wavu-guide"') || b.startsWith('<data kind="clan-tips"')).join("\n").matchAll(/\[\[([^\]]+)\]\]/g)]
      .map((m) => m[1]).filter((id) => allMap.has(id)));
    for (const id of sourceIds) for (const m of index.chain(id)) sourceIds.add(m.id);
    const refs = [...sourceIds].filter((id) => !fullFactIds.has(id)).sort();
    const compact = (id) => {
      const m = allMap.get(id), f = facts.get(id);
      const short = (value, length = 30) => plain(value).slice(0, length) || "unknown";
      const bits = [ref(m), `startup ${short(m.startup)}`, `block ${short(m.block)}`, `hit ${short(m.hit)}`, `CH ${short(m.ch)}`,
        `level ${short(m.target, 20)}`, `damage ${short(m.damage)}`];
      if (m.crush) bits.push(`crush ${short(m.crush, 40)}`);
      if (f.tags.length) bits.push(`tags ${f.tags.join(",")}`);
      if (m.startup_eff != null) bits.push(`effective i${m.startup_eff}${m.timing_note ? ` ${short(m.timing_note, 60)}` : ""}`);
      if (f.combo?.total != null) bits.push(`normal-hit combo ${f.combo.total}`);
      if (f.chCombo?.total != null) bits.push(`CH combo ${f.chCombo.total}`);
      if (m.heat_dash) bits.push(`Heat dash ${short(m.heat_dash, 40)}`);
      if (m.throw_break) bits.push(`throw break ${short(m.throw_break, 20)}`);
      const note = noteItems(m.notes).filter((n) => /whiff|duck|interrupt|jail|crush|heat|tracking/i.test(n)).join("; ");
      if (note) bits.push(`conditions ${short(note, 100)}`);
      return bits.join(" · ");
    };
    const groups = [];
    for (let i = 0; i < refs.length; i += DOSSIER_LIMITS.rows) {
      const ids = refs.slice(i, i + DOSSIER_LIMITS.rows);
      const title = `Source/tip move facts ${1 + Math.floor(i / DOSSIER_LIMITS.rows)}`;
      groups.push(`## ${title}\n${ids.map(compact).join("\n")}`);
      sections[`source-facts:${i}`] = { title, rows: ids.length, available: ids.length };
    }
    if (groups.length) blocks.push(`<data kind="referenced-moves">\n${groups.join("\n\n")}\n</data>`);
  };
  updateReferencedFacts();
  const updateCoverage = () => {
    for (const character of characters) {
      const supplied = selected.filter((s) => s.page.startsWith(`${character} `) && blocks.some((b) => b.startsWith('<data kind="wavu-guide"') && b.includes(`id="${attr(s.id)}"`)));
      const includedKinds = Object.fromEntries(["counterplay", "strategy", "tech"].map((kind) => [kind, supplied.filter((s) => s.kind === kind).reduce((n, s) => n + s.text.length, 0)]));
      const includedCharacters = Object.values(includedKinds).reduce((n, value) => n + value, 0);
      Object.assign(coverageChars[character], { availableKinds: { ...coverageChars[character].kinds }, includedKinds, includedCharacters,
        availableSections: guideSelection[character].report.availableSections, includedSections: supplied.length,
        omittedSections: guideSelection[character].report.omittedSections.length + guideSelection[character].sections.length - supplied.length,
        truncatedSections: guideSelection[character].report.truncatedSections.filter((s) => supplied.some((v) => v.id === s.id)).length,
        includedLevel: includedCharacters < 1000 ? "sparse" : includedCharacters < 10000 ? "ok" : "rich" });
    }
    coverage.level = coverageChars[opponent].includedLevel;
    return `<data kind="coverage">${dataText(JSON.stringify(coverage))}\nLimits: unannotated tracking, string gaps, range/pushback, reactions and frame traps are unknown. Verify punish reach and input timing in practice mode. Sparse guides need clan tips.</data>`;
  };
  blocks.unshift(updateCoverage());
  let text = blocks.join("\n\n");
  const budget = mode === "matchup" ? DOSSIER_LIMITS.matchupChars : DOSSIER_LIMITS.counterChars;
  // Drop complete lower-priority source blocks if the aggregate reaches the budget. Never cut a fact/ref.
  const omitted = [];
  while (text.length > budget) {
    let drop = -1;
    for (const kind of ["tech", "strategy", "counterplay"]) {
      drop = blocks.findLastIndex((b) => b.startsWith('<data kind="wavu-guide"') && b.includes(`source-kind="${kind}"`));
      if (drop >= 0) break;
    }
    if (drop < 0) break;
    omitted.push(blocks.splice(drop, 1)[0]);
    updateReferencedFacts();
    blocks[0] = updateCoverage();
    text = blocks.join("\n\n");
  }
  if (text.length > budget) throw new Error(`computed coach facts exceed the safe dossier budget (${text.length} > ${budget}); cannot omit required facts or clan tips`);
  const referencedIds = new Set([...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]).filter((id) => allMap.has(id)));
  const moves = new Map([...referencedIds].sort().map((id) => [id, allMap.get(id)]));
  const includedGuides = selected.filter((s) => blocks.some((b) => b.startsWith('<data kind="wavu-guide"') && b.includes(`id="${attr(s.id)}"`)));
  const guideIds = includedGuides.map((s) => s.id);
  const tipIds = blocks.some((b) => b.startsWith('<data kind="clan-tips"')) ? approved.map((t) => t.id) : [];
  const sources = [...new Map(includedGuides.map((s) => [s.page, { page: s.page, url: s.url, license: s.license, kind: s.kind }])).values()];
  const provenance = [...moves].map(([id, m]) => fingerprint(m, facts.get(id)));
  const tipsHash = hashOf(approved);
  const hash = hashOf({ version: DOSSIER_VERSION, mode, as, opponent, language, level, text, provenance, tipsHash });
  // Model may add up to two clearly labelled general-knowledge items when the written guides are thin.
  const thin = characters.filter((c) => (coverageChars[c].includedLevel ?? coverageChars[c].level) !== "rich");
  const selectionOmissions = characters.flatMap((character) => guideSelection[character].report.omittedSections.map((s) => ({ character, ...s })));
  const globalOmissions = selected.filter((s) => !guideIds.includes(s.id)).map((s) => ({ id: s.id, page: s.page, kind: s.kind, reason: "aggregate-budget", characters: s.text.length }));
  return { version: DOSSIER_VERSION, mode, as, opponent, language, level, text, moves, characterNames: [...known].sort(),
    stances: Object.entries(stanceTable(opponent)).filter(([abbr]) => allMap.size && [...allMap.values()].some((m) => m.character === opponent && new RegExp(`(?:^|[,.])${abbr}\\.`).test(m.key))).map(([abbr, st]) => ({ abbr, name: st.name, input: st.input })),
    generalKnowledge: { allowed: thin.length > 0, max: thin.length ? 2 : 0, thinCharacters: thin }, allowedIds: referencedIds, tips: approved.filter((t) => tipIds.includes(t.id)),
    facts: new Map([...moves.keys()].map((id) => [id, facts.get(id)])), hash, tipsHash, coverage, dataVersion,
    requiredUnsafe, escapeAnswers, interactions, sections, guideIds, tipIds, sources, omittedSources: selectionOmissions.length + globalOmissions.length,
    guideSelection: Object.fromEntries(characters.map((c) => [c, guideSelection[c].report])), omittedGuideSections: [...selectionOmissions, ...globalOmissions],
    limits: { ...DOSSIER_LIMITS, budget }, omittedGuideIds: [...new Set([...selectionOmissions, ...globalOmissions].map((s) => s.id))],
    truncated: omitted.length > 0 || selectionOmissions.length > 0 || selected.some((s) => s.truncated) || Object.values(sections).some((s) => s.available > s.rows) };
}

