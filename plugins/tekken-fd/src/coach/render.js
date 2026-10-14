import { cleanInline } from "../format.js";
import { bestPunish } from "../matchup.js";
import { strictKey } from "../notation.js";
import { refsOf } from "./validate.js";
import { prettyKey } from "../stances.js";

export const esc = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TITLES = {
  en: { gameplan: "How they play", your_plan: "Your plan", stances: "Stances", your_best_tools: "Your best tools", stop_doing: "Stop doing", key_threats: "Key threats", defense: "Defense", punish: "Punish", lows: "Lows", their_turn: "Their turn", neutral: "Neutral", heat_and_wall: "Heat / wall", common_mistakes: "Common mistakes", lab_drill: "Lab drills", general_knowledge: "⚠️ General knowledge (unverified)", gaps: "Evidence gaps" },
  ru: { gameplan: "Как он играет", your_plan: "Ваш план", stances: "Стойки", your_best_tools: "Ваши лучшие инструменты", stop_doing: "От чего отказаться", key_threats: "Главные угрозы", defense: "Защита", punish: "Наказание", lows: "Лоу", their_turn: "Ход соперника", neutral: "Нейтрал", heat_and_wall: "Heat / стена", common_mistakes: "Частые ошибки", lab_drill: "Тренировки", general_knowledge: "⚠️ Общие знания (не проверено)", gaps: "Пробелы в данных" },
};
const ORDER = ["gameplan", "your_plan", "your_best_tools", "stop_doing", "stances", "key_threats", "defense", "punish", "lows", "their_turn", "neutral", "heat_and_wall", "common_mistakes", "lab_drill", "general_knowledge", "gaps"];
/** Guide views: one message, switched by buttons. */
export const VIEWS = {
  overview: { en: "🏠 Overview", ru: "🏠 Обзор", keys: ["gameplan"] },
  plan: { en: "🎯 Your plan", ru: "🎯 Ваш план", keys: ["your_plan", "your_best_tools", "stop_doing"] },
  stances: { en: "🥋 Stances", ru: "🥋 Стойки", keys: ["stances"] },
  threats: { en: "⚠️ Threats", ru: "⚠️ Угрозы", keys: ["key_threats"] },
  defense: { en: "🛡 Defense", ru: "🛡 Защита", keys: ["defense", "lows"] },
  punish: { en: "💥 Punish", ru: "💥 Наказание", keys: ["punish"] },
  neutral: { en: "⚔️ Neutral & pressure", ru: "⚔️ Нейтрал и давление", keys: ["neutral", "their_turn"] },
  heat: { en: "🔥 Heat / wall", ru: "🔥 Heat / стена", keys: ["heat_and_wall"] },
  mistakes: { en: "❌ Mistakes", ru: "❌ Ошибки", keys: ["common_mistakes"] },
  drills: { en: "🧪 Drills", ru: "🧪 Тренировки", keys: ["lab_drill"] },
  notes: { en: "📝 Notes", ru: "📝 Заметки", keys: ["general_knowledge", "gaps"] },
};
const filled = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim().length > 0);
/** Views that have content in this guide, in display order. */
export const availableViews = (guide) => Object.keys(VIEWS).filter((v) => v === "overview" || VIEWS[v].keys.some((k) => filled(guide?.[k])));
const SECTION = { heat: "heat_and_wall", wall: "heat_and_wall", drill: "lab_drill" };
const getLang = (dossier) => dossier.language === "en" ? "en" : "ru";
const ACTION_WORDS = {
  en: { crouch_block: "block low", punish: "punish", interrupt: "interrupt the gap", duck: "duck", SSL: "sidestep left", SSR: "sidestep right", SWL: "sidewalk left", SWR: "sidewalk right" },
  ru: { crouch_block: "блок сидя", punish: "наказать", interrupt: "перебить в паузе", duck: "присесть", SSL: "сайдстеп влево", SSR: "сайдстеп вправо", SWL: "обход влево", SWR: "обход вправо" },
};
// sendHtml() falls back to truncated plain text above 4000 visible characters; raw HTML is
// always at least as long as its visible text, so a 3800-character raw cap stays under it.
export const MESSAGE_LIMIT = 3800;

/** Conservative raw-HTML limit; close and reopen tags rather than slicing markup/entities. */
export function splitHtml(html, limit = 4096) {
  if (!Number.isInteger(limit) || limit < 256) throw new Error("HTML limit must be at least 256");
  const parts = [];
  const stack = [];
  let part = "";
  const close = () => [...stack].reverse().map((x) => `</${x.name}>`).join("");
  const reopen = () => stack.map((x) => x.tag).join("");
  const flush = () => {
    if (part) parts.push(part + close());
    part = reopen();
  };
  const tokens = String(html).match(/<[^>]*>|&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);|[^<&]+|[<&]/gi) ?? [];
  for (const token of tokens) {
    const isTag = token.startsWith("<") && token.endsWith(">");
    const opening = isTag && token.match(/^<([a-z]+)(?:\s[^>]*)?>$/i);
    const closing = isTag && token.match(/^<\/([a-z]+)>$/i);
    const atoms = isTag || token.startsWith("&") ? [token] : [...token];
    for (const atom of atoms) {
      const extraClose = opening ? `</${opening[1].toLowerCase()}>`.length : closing ? -token.length : 0;
      if (part.length + atom.length + close().length + extraClose > limit) flush();
      if (part.length + atom.length + close().length + extraClose > limit) throw new Error("Single HTML token exceeds message limit");
      part += atom;
      if (opening) stack.push({ name: opening[1].toLowerCase(), tag: token });
      if (closing) {
        if (stack.at(-1)?.name !== closing[1].toLowerCase()) throw new Error("Unbalanced generated HTML");
        stack.pop();
      }
    }
  }
  if (stack.length) throw new Error("Unclosed generated HTML");
  if (part) parts.push(part);
  return parts.length ? parts : [""];
}

function currentMove(index, dossier, id) {
  // Never render stale dossier frames after an index rebuild.
  return typeof index?.move === "function" ? index.move(id) : null;
}

function moveHtml(index, dossier, id) {
  const m = currentMove(index, dossier, id);
  if (!m) return `<i>${getLang(dossier) === "en" ? "move missing from current index" : "приём отсутствует в текущем индексе"}</i>`;
  let chain = [m];
  if (typeof index.chain === "function") chain = index.chain(id);
  const startup = cleanInline(chain[0]?.startup ?? m.startup);
  const followup = m.parent ? cleanInline(m.startup) : "";
  const block = cleanInline(m.block);
  const target = chain.map((r) => cleanInline(r.target).replace(/^,\s*/, "")).filter(Boolean).join(",");
  const damage = chain.map((r) => cleanInline(r.damage).replace(/^,\s*/, "")).filter(Boolean).join(",");
  const facts = [startup ? (/^i/i.test(startup) ? startup : `i${startup}`) : null,
    followup && followup !== startup ? `${getLang(dossier) === "en" ? "follow-up" : "продолжение"} ${/^i/i.test(followup) ? followup : `i${followup}`}` : null,
    block || null, target || null, damage ? `${getLang(dossier) === "en" ? "damage" : "урон"} ${damage}` : null].filter(Boolean);
  return `<code>${esc(prettyKey(m.character, m.key ?? id))}</code>${facts.length ? ` <i>(${esc(facts.join(" · "))})</i>` : ""}`;
}

function textHtml(index, dossier, text) {
  const out = [];
  let offset = 0;
  for (const m of String(text ?? "").matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)) {
    out.push(esc(String(text).slice(offset, m.index)), moveHtml(index, dossier, m[1]));
    offset = m.index + m[0].length;
  }
  out.push(esc(String(text ?? "").slice(offset)));
  return out.join("");
}

function sectionRows(index, guide, dossier, key) {
  const render = (value) => textHtml(index, dossier, value);
  const value = guide[key];
  if (typeof value === "string") return [render(value)];
  if (!Array.isArray(value)) return [];
  const en = getLang(dossier) === "en";
  return value.map((item) => {
    if (typeof item === "string") return `• ${render(item)}`;
    if (key === "stances") {
      return [`🥋 <b>${esc(item.stance)}</b>${item.entry ? ` <i>(${render(item.entry)})</i>` : ""}`, item.threats ? `${en ? "Threats" : "Угрозы"}: ${render(item.threats)}` : null,
        item.answer ? `→ ${render(item.answer)}` : null].filter(Boolean).join("\n");
    }
    if (key === "lab_drill") {
      return [`🧪 <b>${esc(item.title ?? "")}</b>`, item.setup ? `<i>${en ? "Setup" : "Настройка"}:</i> ${render(item.setup)}` : null,
        ...(Array.isArray(item.steps) ? item.steps.map((step, i) => `${i + 1}. ${render(step)}`) : []),
        item.goal ? `🎯 ${render(item.goal)}` : null].filter(Boolean).join("\n");
    }
    const subject = item.move ?? item.situation;
    const bits = [subject ? render(subject) : null, item.why ? render(item.why) : null, item.answer ? `→ ${render(item.answer)}` : null, item.reward ? render(item.reward) : null, item.note ? `<i>${render(item.note)}</i>` : null].filter(Boolean);
    if (key === "punish" && dossier.mode !== "matchup" && item.move) {
      const m = currentMove(index, dossier, refsOf(item.move)[0]);
      if (typeof m?.block_n === "number" && m.block_n <= -10) bits.push(`<i>${getLang(dossier) === "en" ? "block punish window" : "окно наказания на блоке"}: ${Math.abs(m.block_n)}</i>`);
    }
    return `• ${bits.join(" · ")}`;
  });
}

/** Credits the clan members whose approved tips the guide used; empty when none were used. */
function footer(dossier, guide) {
  const en = getLang(dossier) === "en";
  const tips = (dossier.tips ?? []).filter((t) => (guide.used_tips ?? []).includes(t.id));
  const authors = [...new Set(tips.filter((t) => t.author).map((t) => `${t.author}${t.needsReview || t.status === "needs-review" ? (en ? " (may be outdated)" : " (может быть устаревшим)") : ""}`))];
  return authors.length ? `<i>${en ? "Clan tips" : "Советы клана"}: ${authors.map(esc).join(", ")}.</i>` : "";
}

function header(guide, dossier, model, createdAt) {
  const en = getLang(dossier) === "en";
  const title = dossier.mode === "matchup" ? `${dossier.as} vs ${dossier.opponent}` : `${en ? "Against" : "Против"} ${dossier.opponent}`;
  const confidence = en ? guide.confidence : ({ high: "высокая", medium: "средняя", low: "низкая" }[guide.confidence] ?? guide.confidence);
  return `🎓 <b>${esc(title)}</b> · ${esc(String(model).replace(/^openai\//, ""))} · ${esc(String(createdAt).slice(0, 10))} · ${en ? "confidence" : "уверенность"}: ${esc(confidence)}`;
}

/**
 * One view of a validated guide, sized for a single Telegram message (long views are paged).
 * @returns {{html: string, page: number, pages: number, view: string}}
 */
export function renderView(index, guide, dossier, { view = "overview", page = 0, model = "unknown", createdAt = new Date().toISOString() } = {}) {
  const en = getLang(dossier) === "en";
  const v = VIEWS[view] ? view : "overview";
  const lines = [header(guide, dossier, model, createdAt)];
  if (v === "overview") lines.push(textHtml(index, dossier, guide.summary));
  else lines.push(`<b>${esc(VIEWS[v][en ? "en" : "ru"])}</b>`);
  for (const key of VIEWS[v].keys) {
    const rows = sectionRows(index, guide, dossier, key);
    if (!rows.length) continue;
    if (VIEWS[v].keys.length > 1 || v === "overview") lines.push(`<b>${esc(TITLES[en ? "en" : "ru"][key] ?? key)}</b>`);
    lines.push(rows.join(key === "stances" || key === "lab_drill" ? "\n\n" : "\n"));
  }
  if (v === "overview") {
    const credit = footer(dossier, guide);
    if (credit) lines.push(credit);
    lines.push(`<i>${en ? "Tap a section below." : "Выберите раздел ниже."}</i>`);
  }
  const pages = splitHtml(lines.join("\n\n"), MESSAGE_LIMIT);
  const n = Math.min(Math.max(0, page), pages.length - 1);
  return { html: pages[n], page: n, pages: pages.length, view: v };
}

/** Render only a successfully validated guide. HTML is escaped before adding trusted tags. */
export function renderGuide(index, guide, dossier, { model = "unknown", createdAt = new Date().toISOString(), section = "all" } = {}) {
  const en = getLang(dossier) === "en";
  const title = dossier.mode === "matchup" ? `${dossier.as} vs ${dossier.opponent}` : `${en ? "Against" : "Против"} ${dossier.opponent}`;
  const date = String(createdAt).slice(0, 10);
  const confidence = en ? guide.confidence : ({ high: "высокая", medium: "средняя", low: "низкая" }[guide.confidence] ?? guide.confidence);
  const lines = [`🎓 <b>${esc(title)}</b> · ${esc(String(model).replace(/^openai\//, ""))} · ${esc(date)} · ${en ? "confidence" : "уверенность"}: ${esc(confidence)}`];
  const selected = SECTION[section] ?? section;
  if (selected === "all") lines.push(textHtml(index, dossier, guide.summary));
  const keys = selected === "all" ? ORDER : selected === "neutral" && dossier.mode === "matchup" ? ["gameplan", "your_best_tools"] : [selected];
  for (const key of keys) {
    const rows = sectionRows(index, guide, dossier, key);
    if (!rows.length) continue;
    lines.push(`<b>${esc(TITLES[en ? "en" : "ru"][key] ?? key)}</b>`, `<blockquote expandable>${rows.join("\n")}</blockquote>`);
  }
  const credit = footer(dossier, guide);
  if (credit) lines.push(credit);
  return splitHtml(lines.join("\n\n"), MESSAGE_LIMIT);
}

/** Deterministic evidence sheet if isolated model completion or validation fails. */
export function renderFallback(index, dossier, reason = "") {
  const en = getLang(dossier) === "en";
  const title = dossier.as ? `${dossier.as} vs ${dossier.opponent}` : `${en ? "Against" : "Против"} ${dossier.opponent}`;
  const rows = [`🛡 <b>${esc(title)}</b>`, en ? "The coach could not produce a verified guide. Current index facts:" : "Тренер не смог подготовить проверенный гайд. Факты текущего индекса:"];
  // Failure diagnostics may quote unsupported claims; never reproduce those numbers to users.
  if (reason) rows.push(`<i>${esc(String(reason).slice(0, 400).replace(/[+−-]?\p{N}+/gu, "…"))}</i>`);
  for (const row of dossier.requiredUnsafe ?? []) {
    const threat = currentMove(index, dossier, row.move);
    if (!threat) continue;
    let answer = null;
    if (dossier.as && typeof index?.curatedPunishers === "function") {
      try {
        const chosen = bestPunish(index, dossier.as, threat);
        if (chosen?.key && typeof index.byKey === "function") {
          answer = index.byKey(dossier.as, "strict", strictKey(chosen.key))[0]?.id ?? null;
        }
      } catch { /* stay with facts */ }
    }
    if (!answer && row.answer) {
      const p = currentMove(index, dossier, row.answer);
      const root = p && typeof index.chain === "function" ? index.chain(p.id)[0] : p;
      if (p && p.character === dossier.as && Number.isFinite(root?.startup_eff) && Number.isFinite(threat.block_n) && root.startup_eff <= -threat.block_n) answer = p.id;
    }
    const suffix = answer ? ` → ${moveHtml(index, dossier, answer)} <i>(${en ? "check reach in practice" : "проверьте дальность в тренировке"})</i>` : threat.block_n <= -10 ? ` · ${en ? "block punish window" : "окно наказания на блоке"}: ${Math.abs(threat.block_n)}` : "";
    rows.push(`${moveHtml(index, dossier, row.move)}${suffix}`);
  }
  for (const row of (dossier.escapeAnswers ?? []).slice(0, 7)) {
    const m = currentMove(index, dossier, row.move);
    if (!m) continue;
    rows.push(`${moveHtml(index, dossier, row.move)} · ${esc((row.actions ?? []).map((a) => ACTION_WORDS[getLang(dossier)][a] ?? a).join(", "))}${row.answer ? ` → ${moveHtml(index, dossier, row.answer)}` : ""}`);
  }
  return splitHtml(rows.join("\n\n"), MESSAGE_LIMIT);
}
