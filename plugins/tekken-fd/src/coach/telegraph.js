// Full coach guides as telegra.ph pages (opened with Instant View inside Telegram).
// Pages are public to anyone with the link: no Telegram ids, no tip author names.
import fs from "node:fs";
import path from "node:path";
import { prettyKey } from "../stances.js";
import { cleanInline } from "../format.js";
import { VIEWS } from "./render.js";

const API = "https://api.telegra.ph";
const MAX_CONTENT = 60000; // Telegraph limit is 64 KB of serialized content

export class TelegraphClient {
  constructor({ stateDir, fetchImpl = fetch, shortName = "TekkenCoach", authorName = "Tekken coach" }) {
    this.file = path.join(stateDir, "telegraph.json");
    this.fetch = fetchImpl;
    this.shortName = shortName;
    this.authorName = authorName;
  }
  async call(method, params) {
    const body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
    const res = await this.fetch(`${API}/${method}`, { method: "POST", body, signal: AbortSignal.timeout(20000) });
    const json = await res.json();
    if (!json.ok) throw new Error(`telegra.ph ${method}: ${json.error}`);
    return json.result;
  }
  /** One anonymous Telegraph account for the bot; its token lives in the private state dir. */
  async token() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")).access_token; } catch { /* first use */ }
    const account = await this.call("createAccount", { short_name: this.shortName, author_name: this.authorName });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ access_token: account.access_token, short_name: account.short_name }), { mode: 0o600 });
    return account.access_token;
  }
  /** Create the page, or edit it in place when `pagePath` is known (links stay valid). */
  async publish({ pagePath = null, title, content }) {
    const access_token = await this.token();
    const params = { access_token, title: title.slice(0, 256), author_name: this.authorName, content, return_content: "false" };
    const page = pagePath ? await this.call("editPage", { ...params, path: pagePath }) : await this.call("createPage", params);
    return { path: page.path, url: page.url };
  }
}

const t = (lang, en, ru) => (lang === "ru" ? ru : en);

/** Text with [[id]] tokens → Telegraph nodes: readable move name in code + current frame facts. */
function textNodes(index, text, scrub) {
  const out = [];
  let rest = scrub(String(text ?? ""));
  let offset = 0;
  for (const m of rest.matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)) {
    if (m.index > offset) out.push(rest.slice(offset, m.index));
    const move = index.move?.(m[1]);
    if (move) {
      const chain = index.chain?.(move.id) ?? [move];
      const facts = [cleanInline(chain[0]?.startup ?? move.startup), cleanInline(move.block), chain.map((r) => cleanInline(r.target)).filter(Boolean).join(",")].filter(Boolean);
      out.push({ tag: "code", children: [prettyKey(move.character, move.key)] });
      if (facts.length) out.push({ tag: "em", children: [` (${facts.join(" · ")})`] });
    } else out.push(m[1]);
    offset = m.index + m[0].length;
  }
  if (offset < rest.length) out.push(rest.slice(offset));
  return out;
}

/**
 * Validated guide → Telegraph content nodes, in the same section order as the in-chat views.
 * Tip authors are replaced by "a clan member"; one source credit at the end (CC BY-SA requires it).
 */
export function guideNodes(index, guide, dossier, { model = "", createdAt = "" } = {}) {
  const lang = dossier.language === "ru" ? "ru" : "en";
  const authors = (dossier.tips ?? []).map((tip) => tip.author).filter((a) => a && a !== "Clan member");
  const scrub = (s) => authors.reduce((text, name) => text.split(name).join(t(lang, "a clan member", "участник клана")), s);
  const tx = (s) => textNodes(index, s, scrub);
  const nodes = [{ tag: "p", children: [{ tag: "em", children: [`${t(lang, "Generated", "Создано")} ${String(createdAt).slice(0, 10)} · ${String(model).replace(/^openai\//, "")} · ${t(lang, "confidence", "уверенность")}: ${guide.confidence}`] }] }];
  nodes.push({ tag: "p", children: tx(guide.summary) });
  const titles = { gameplan: t(lang, "How they play", "Как он играет"), your_plan: t(lang, "Your plan", "Ваш план"), your_best_tools: t(lang, "Your best tools", "Ваши лучшие инструменты"),
    stop_doing: t(lang, "Stop doing", "От чего отказаться"), lows: t(lang, "Lows", "Лоу"), their_turn: t(lang, "Their turn", "Ход соперника"), neutral: t(lang, "Neutral", "Нейтрал"),
    general_knowledge: t(lang, "General knowledge (unverified)", "Общие знания (не проверено)"), gaps: t(lang, "Evidence gaps", "Пробелы в данных") };
  const item = (key, it) => {
    if (typeof it === "string") return { tag: "li", children: tx(it) };
    if (key === "stances") return [{ tag: "h4", children: [it.stance ?? ""] }, ...(it.entry ? [{ tag: "p", children: [{ tag: "em", children: [t(lang, "Entry: ", "Вход: ")] }, ...tx(it.entry)] }] : []),
      ...(it.threats ? [{ tag: "p", children: [{ tag: "strong", children: [t(lang, "Threats: ", "Угрозы: ")] }, ...tx(it.threats)] }] : []),
      ...(it.answer ? [{ tag: "p", children: [{ tag: "strong", children: [t(lang, "Answer: ", "Ответ: ")] }, ...tx(it.answer)] }] : [])];
    if (key === "lab_drill") return [{ tag: "h4", children: [it.title ?? ""] }, ...(it.setup ? [{ tag: "p", children: [{ tag: "em", children: [t(lang, "Setup: ", "Настройка: ")] }, ...tx(it.setup)] }] : []),
      { tag: "ol", children: (it.steps ?? []).map((s) => ({ tag: "li", children: tx(s) })) }, ...(it.goal ? [{ tag: "p", children: [{ tag: "strong", children: [t(lang, "Goal: ", "Цель: ")] }, ...tx(it.goal)] }] : [])];
    const parts = [];
    for (const [field, prefix] of [["move", ""], ["situation", ""], ["why", " — "], ["answer", " → "], ["reward", " · "], ["note", " · "]]) {
      if (!it[field]) continue;
      if (prefix) parts.push(prefix);
      parts.push(...tx(it[field]));
    }
    if (key === "punish" && dossier.mode !== "matchup") {
      const move = index.move?.(String(it.move ?? "").replace(/^\[\[|\]\]$/g, ""));
      if (typeof move?.block_n === "number" && move.block_n <= -10) parts.push({ tag: "em", children: [` (${t(lang, "punish window", "окно наказания")} ${Math.abs(move.block_n)})`] });
    }
    return { tag: "li", children: parts };
  };
  for (const [view, spec] of Object.entries(VIEWS)) {
    const keys = spec.keys.filter((k) => (Array.isArray(guide[k]) ? guide[k].length : String(guide[k] ?? "").trim()));
    if (!keys.length || (view === "plan" && dossier.mode !== "matchup")) continue;
    nodes.push({ tag: "h3", children: [view === "overview" ? titles.gameplan : spec[lang].replace(/^\S+\s/, "")] });
    for (const key of keys) {
      if (spec.keys.length > 1 && view !== "overview") nodes.push({ tag: "h4", children: [titles[key] ?? key] });
      const value = guide[key];
      if (typeof value === "string") { nodes.push({ tag: "p", children: tx(value) }); continue; }
      if (key === "stances" || key === "lab_drill") nodes.push(...value.flatMap((it) => item(key, it)));
      else nodes.push({ tag: key === "general_knowledge" ? "ul" : "ul", children: value.map((it) => item(key, it)) });
    }
  }
  if ((guide.used_tips ?? []).length) nodes.push({ tag: "p", children: [{ tag: "em", children: [t(lang, `Includes ${guide.used_tips.length} approved clan tip(s).`, `Включает одобренные советы клана: ${guide.used_tips.length}.`)] }] });
  nodes.push({ tag: "hr" }, { tag: "p", children: [{ tag: "em", children: [t(lang, "Frame data and community guides: ", "Фреймдата и гайды сообщества: "),
    { tag: "a", attrs: { href: "https://wavu.wiki" }, children: ["Wavu Wiki"] }, " (CC BY-SA 4.0)."] }] });
  // stay under Telegraph's size limit: drop trailing sections' detail rather than fail
  while (JSON.stringify(nodes).length > MAX_CONTENT && nodes.length > 4) nodes.splice(nodes.length - 3, 1);
  return nodes;
}

export function guideTitle(dossier) {
  const lang = dossier.language === "ru" ? "ru" : "en";
  return dossier.mode === "matchup"
    ? t(lang, `${dossier.as} vs ${dossier.opponent} — Tekken 8 matchup guide`, `${dossier.as} против ${dossier.opponent} — гайд по матчапу Tekken 8`)
    : t(lang, `How to play against ${dossier.opponent} — Tekken 8 guide`, `Как играть против ${dossier.opponent} — гайд Tekken 8`);
}
