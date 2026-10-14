// Command-only Wavu guide source. Stored prose is reference material, never instructions.
import { API_URL, USER_AGENT } from "./wavu.js";
import { strictKey } from "./notation.js";
import { setTimeout as pause } from "node:timers/promises";

export const GUIDE_KINDS = ["counterplay", "strategy", "tech"];
export const GUIDE_LICENSE = "CC BY-SA 4.0";
export const guideUrl = (page) => `https://wavu.wiki/t/${encodeURIComponent(page.replace(/ /g, "_"))}`;

/** Remove nested wiki templates without letting template bodies leak into guide text. */
function stripTemplates(text) {
  let out = "", depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.slice(i, i + 2) === "{{") { depth++; i++; }
    else if (depth && text.slice(i, i + 2) === "}}") { depth--; i++; }
    else if (!depth) out += text[i];
  }
  return out;
}

/** Convert only unique, indexed notation; preserve unmatched notation as plain text. */
export function linkGuideMoves(text, character, moves = []) {
  const rows = moves instanceof Map ? [...moves.values()] : moves;
  const ids = new Set(rows.map((m) => m.id));
  const byKey = new Map();
  for (const m of rows) {
    if (m.character && m.character !== character) continue;
    const key = strictKey(m.key ?? m.id.slice(character.length + 1));
    byKey.set(key, byKey.has(key) ? null : m.id);
  }
  const resolve = (v) => ids.has(v) ? v : byKey.get(strictKey(v));
  const unknown = [];
  let result = String(text ?? "").replace(/\[\[([^\[\]]+)\]\]/g, (_, id) => {
    if (ids.has(id)) return `[[${id}]]`;
    unknown.push(id);
    return `\u0001${unknown.length - 1}\u0002`;
  });
  // Protect existing references while matching notation, including ws/FC/stance inputs.
  result = result.split(/(\[\[[^\[\]]+\]\])/).map((part) => {
    if (part.startsWith("[[")) return part;
    return part.replace(/(?<![\w+\-])(?:[A-Z][A-Za-z]*\.|ws|wr|[qhd]c[fb]|[udfbn]{1,2}(?:[\/,][udfbn]{1,2})*[+:]?)?(?:[1-4](?:[+,~][1-4])*)(?:,[A-Za-z]+)?(?![\w+])/g,
      (notation) => { if (/^[1-4]$/.test(notation)) return notation; const id = resolve(notation); return id ? `[[${id}]]` : notation; });
  }).join("");
  return result.replace(/\u0001(\d+)\u0002/g, (_, n) => unknown[Number(n)]);
}

function cleanWiki(text) {
  // Move templates survive cleaning as id references and are checked against the index at selection time.
  let t = String(text ?? "").replace(/<!--[^]*?-->/g, "").replace(/<ref\b[^>]*>[^]*?<\/ref>|<ref\b[^>]*\/\s*>/gi, "");
  t = t.replace(/\{\{\s*(?:Move|MoveLink|Move link)\s*\|\s*([^|{}]+)(?:\|[^{}]*)?\}\}/gi, (_, id) => `[[${id.trim()}]]`);
  t = stripTemplates(t);
  t = t.replace(/\[\[([^\[\]]+)\]\]/g, (_, link) => {
    if (/^[^|]+-[^|]*[1-4]/.test(link)) return `[[${link}]]`;
    return link.split("|").at(-1).replace(/_/g, " ");
  }).replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, "$2").replace(/\[https?:\/\/[^\]]+\]/g, "")
    .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/'{2,5}/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return t.split("\n").map((line) => line.replace(/^\s*[*#:;]+\s*/, "- ").trim()).filter((line) => !/^\{\||^\|}|^\|-|^\|\+|^__|^\[?Category:/i.test(line)).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
}

/** Parse headings as a hierarchy, retaining list lines and source provenance. */
export function parseGuide(wikitext, character, kind, { page = `${character} ${kind}`, moves } = {}) {
  const sections = [];
  let heading = [], body = [];
  const flush = () => {
    let text = cleanWiki(body.join("\n"));
    if (moves) text = linkGuideMoves(text, character, moves);
    if (text.replace(/\[\[[^\]]+\]\]/g, "move").replace(/[^A-Za-zА-Яа-я]/g, "").length >= 20) {
      const anchor = heading.join(" / ") || "Introduction";
      sections.push({ id: `${page}#${anchor}`, page, heading: [...heading], text });
    }
    body = [];
  };
  for (const line of String(wikitext ?? "").split("\n")) {
    const h = line.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
    if (!h) { body.push(line); continue; }
    flush();
    heading = heading.slice(0, h[1].length - 2);
    heading.push(cleanWiki(h[2]));
  }
  flush();
  const coverage = sections.reduce((n, s) => n + s.text.length, 0);
  return { page, kind, url: guideUrl(page), license: GUIDE_LICENSE, sections, coverage };
}

export const parseGuides = parseGuide;

export function guideCoverage(characterGuides = {}) {
  const kinds = Object.fromEntries(GUIDE_KINDS.map((kind) => [kind, characterGuides[kind]?.sections?.reduce((n, s) => n + s.text.length, 0) ?? 0]));
  const characters = Object.values(kinds).reduce((a, b) => a + b, 0);
  return { kinds, characters, level: characters < 1000 ? "sparse" : characters < 10000 ? "ok" : "rich" };
}

/** Fetch on /fd_sync only. Failures are reported per kind so sync can retain last good pages. */
export async function fetchGuides(characters, { fetchImpl = fetch, onProgress, withReport = false, pauseMs = 150, timeoutMs = 20000, retries = 1 } = {}) {
  const data = {};
  const report = { ok: 0, missing: [], errors: [], failedKinds: {} };
  let done = 0;
  for (const character of characters) {
    const pages = {};
    let hadError = false;
    for (const kind of GUIDE_KINDS) {
      try {
        const page = `${character} ${kind}`;
        const url = `${API_URL}?${new URLSearchParams({ format: "json", action: "parse", page, prop: "wikitext", redirects: "1" })}`;
        let body;
        for (let attempt = 0; attempt <= retries; attempt++) {
          let response;
          try {
            response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
          } catch (err) {
            if (attempt === retries) throw err;
            if (pauseMs > 0) await pause(Math.max(pauseMs, 500));
            continue;
          }
          if (!response.ok) {
            if (attempt < retries && (response.status === 429 || response.status >= 500)) {
              if (pauseMs > 0) await pause(Math.max(pauseMs, 500));
              continue;
            }
            throw new Error(`HTTP ${response.status}`);
          }
          body = await response.json();
          break;
        }
        if (body.error) throw new Error(`${body.error.code}: ${body.error.info ?? ""}`);
        const parsed = parseGuide(body.parse?.wikitext?.["*"], character, kind);
        if (parsed.coverage) pages[kind] = parsed;
      } catch (err) {
        if (!/missingtitle|HTTP 404/.test(String(err.message))) {
          hadError = true;
          (report.failedKinds[character] ??= []).push(kind);
        }
      }
      if (pauseMs > 0) await pause(pauseMs);
    }
    const present = Object.keys(pages).length > 0;
    if (present) { data[character] = pages; report.ok++; }
    if (hadError) report.errors.push(character);
    else if (!present) report.missing.push(character);
    onProgress?.({ done: ++done, total: characters.length, character, status: hadError ? "error" : present ? "ok" : "missing" });
  }
  return withReport ? { data, report } : data;
}

/**
 * Keep a previous page only when fetching that page failed (network/HTTP error). A page that is now
 * missing on Wavu or reduced to the empty template is dropped, so deleted advice does not live forever.
 */
export function mergeGuideSnapshots(previous = {}, fresh = {}, report = {}) {
  const out = {};
  const failed = (character, kind) => (report.failedKinds?.[character] ?? []).includes(kind);
  for (const character of [...new Set([...Object.keys(previous), ...Object.keys(fresh)])].sort()) {
    out[character] = {};
    for (const kind of GUIDE_KINDS) {
      const value = fresh[character]?.[kind] ?? (failed(character, kind) ? previous[character]?.[kind] : undefined);
      if (value?.sections?.length) out[character][kind] = value;
    }
    if (!Object.keys(out[character]).length) delete out[character];
  }
  return out;
}

const STRATEGY_HEADINGS = /key moves|game\s?plan|neutral|close range|heat|pressure|offen[cs]e|defen[cs]e|punish|weakness|strength|overview/i;

/** Counterplay first, relevant matchup subsections first; tech is only for the player's character. */
export function selectGuides(guides, character, { as = false, opponent = null, moves = [], maxChars = 22000, withReport = false } = {}) {
  const pages = guides?.[character] ?? {};
  const chosen = [];
  const report = { availableSections: 0, eligibleSections: 0, selectedSections: 0, omittedSections: [], truncatedSections: [], inputCharacters: 0 };
  const omit = (s, kind, reason) => report.omittedSections.push({ id: s.id, page: s.page, kind, reason, characters: s.text.length });
  let used = 0;
  const reserveTech = as && pages.tech?.sections?.length ? Math.min(8000, Math.floor(maxChars / 4)) : 0;
  for (const kind of GUIDE_KINDS) {
    const page = pages[kind];
    if (!page) continue;
    report.availableSections += (page.sections ?? []).length;
    if (kind === "tech" && !as) {
      for (const s of page.sections ?? []) omit(s, kind, "tech-player-only");
      continue;
    }
    const kindBudget = kind === "tech" ? maxChars : maxChars - reserveTech;
    const namesOtherSide = (s) => Boolean(opponent && s.heading.some((h) => h.toLowerCase().includes(opponent.toLowerCase())));
    const eligible = (page.sections ?? []).filter((s) => {
      // A matchup should not consume character-specific advice for unrelated opponents.
      const matchupHeading = s.heading.findIndex((h) => /match[ -]?ups?/i.test(h));
      if (opponent && matchupHeading >= 0 && s.heading.length > matchupHeading + 1 && !namesOtherSide(s)) {
        omit(s, kind, "unrelated-matchup");
        return false;
      }
      return true;
    });
    report.eligibleSections += eligible.length;
    const preferred = (s) => kind === "strategy" && (!s.heading.length || STRATEGY_HEADINGS.test(s.heading.join(" / ")));
    eligible.sort((a, b) => Number(namesOtherSide(b)) - Number(namesOtherSide(a)) || Number(preferred(b)) - Number(preferred(a)));
    for (const s of eligible) {
      if (used >= kindBudget) { omit(s, kind, "source-budget"); continue; }
      const text = linkGuideMoves(s.text, character, moves);
      const remaining = kindBudget - used;
      let bounded = text;
      if (bounded.length > remaining) {
        // Cut at a newline or sentence; never leave half a move reference in the prompt.
        const cut = bounded.slice(0, remaining);
        const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
        bounded = (boundary > remaining / 2 ? cut.slice(0, boundary) : cut).replace(/\[\[[^\]]*$/, "").trim();
      }
      if (bounded.length < 30) { omit(s, kind, "source-budget"); continue; }
      chosen.push({ ...s, text: bounded, kind, url: page.url ?? guideUrl(page.page), license: GUIDE_LICENSE, truncated: bounded.length < text.length });
      if (bounded.length < text.length) report.truncatedSections.push({ id: s.id, page: s.page, kind, omittedCharacters: text.length - bounded.length });
      used += bounded.length;
    }
  }
  report.selectedSections = chosen.length;
  report.inputCharacters = used;
  return withReport ? { sections: chosen, report } : chosen;
}
