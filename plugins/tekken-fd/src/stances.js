// Human-readable move names: stance abbreviations from each character's Wavu page plus Wavu's general
// notation prefixes ("SSH.3" → "Senshin 3", "H.2+3" → "Heat 2+3", "OTG.d+4" → "d+4 (grounded opponent)").
import fs from "node:fs";
import { API_URL, USER_AGENT } from "./wavu.js";

/** General prefixes from Wavu's Notation page; character stance names take priority. */
export const GENERAL_PREFIXES = {
  H: "Heat", R: "Rage", P: "After parry", J: "Jumping", WR: "While running", WS: "While standing", FC: "Full crouch",
  hFC: "Half crouch", BT: "Back turned", SS: "Sidestep", SSL: "Sidestep left", SSR: "Sidestep right", SW: "Sidewalk",
  SWL: "Sidewalk left", SWR: "Sidewalk right", FUFT: "Face up, feet towards", FUFA: "Face up, feet away",
  FDFT: "Face down, feet towards", FDFA: "Face down, feet away", CD: "Crouch dash", CH: "Counter hit",
};
// Prefixes that describe the opponent rather than your stance read better after the input.
const SUFFIXES = { OTG: "grounded opponent" };

/**
 * Stance list from a character's main page, e.g. "* WGS ''(Wind God Step)'' &ndash; f,n,d,df".
 * @returns {Record<string, {name: string, input: string|null}>}
 */
export function parseStances(wikitext) {
  const out = {};
  const text = String(wikitext ?? "").replace(/&#58;/g, ":").replace(/&ndash;/g, "–");
  // "* ABBR ''(Name)'' – input" (also without the italics, and nested "**" bullets)
  for (const m of text.matchAll(/^\*+\s*([A-Z]{2,5})\s*(?:'')?\(([^)\n]{2,40})\)(?:'')?\s*(?:–|-)?\s*([^\n]*)$/gm)) {
    let input = m[3].replace(/\{\{[^}]*\}\}|<[^>]+>|''/g, "").replace(/\}\}/g, "").replace(/^\*.*$|\s\*\s.*$/, "").replace(/^:\s*/, "").trim();
    if (input.length > 40) input = "";
    out[m[1]] = { name: m[2].trim().replace(/^\w/, (c) => c.toUpperCase()), input: input || null };
  }
  return out;
}

export async function fetchStances(characters, { fetchImpl = fetch, pauseMs = 300, onProgress, withReport = false } = {}) {
  const data = {};
  const report = { ok: 0, missing: [], errors: [] };
  let done = 0;
  for (const character of characters) {
    let status = "missing";
    try {
      const url = `${API_URL}?${new URLSearchParams({ format: "json", action: "parse", page: character, prop: "wikitext", redirects: "1" })}`;
      const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error.code);
      const stances = parseStances(body.parse?.wikitext?.["*"]);
      if (Object.keys(stances).length) { data[character] = stances; status = "ok"; }
    } catch (err) {
      status = /missingtitle|HTTP 404/.test(err.message) ? "missing" : "error";
    }
    if (status === "ok") report.ok++;
    else report[status === "missing" ? "missing" : "errors"].push(character);
    onProgress?.({ done: ++done, total: characters.length, character, status });
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return withReport ? { data, report } : data;
}

let STANCES = {};
/** Load the synced stance table (data/wavu/t8-stances.json); missing file → general prefixes only. */
export function loadStances(file) {
  try { STANCES = JSON.parse(fs.readFileSync(file, "utf8")); } catch { STANCES = {}; }
  return STANCES;
}
export const setStances = (table) => { STANCES = table ?? {}; };
export const stanceTable = (character) => STANCES[character] ?? {};

/**
 * "SSH.3" → "Senshin 3"; "d+2,H.1+2" → "d+2, Heat 1+2"; "OTG.d+4" → "d+4 (grounded opponent)";
 * "H.WRA.2+3" → "Heat Heaven's Wrath 2+3". Unknown prefixes stay as written.
 */
export function prettyKey(character, key) {
  const stances = stanceTable(character);
  return String(key ?? "").split(",").map((segment, i) => {
    let rest = segment;
    const words = [];
    const after = [];
    for (;;) {
      const m = rest.match(/^([A-Za-z][A-Za-z0-9]{0,5})\.(?=.)/);
      if (!m) break;
      const label = stances[m[1]]?.name ?? GENERAL_PREFIXES[m[1]] ?? null;
      if (label) words.push(label);
      else if (SUFFIXES[m[1]]) after.push(SUFFIXES[m[1]]);
      else break;
      rest = rest.slice(m[0].length);
    }
    // lowercase Wavu shorthands written without a dot: ws4, wr2
    const short = rest.match(/^(ws|wr)(?=[1-4])/);
    if (short) { words.push(short[1] === "ws" ? "While standing" : "While running"); rest = rest.slice(2); }
    const text = `${words.length ? `${words.join(" ")} ` : ""}${rest}${after.length ? ` (${after.join(", ")})` : ""}`;
    return i === 0 || !words.length ? text : ` ${text}`;
  }).join(",");
}

/** "Senshin (SSH): f+1+2" lines for a character's stances, for cards and guides. */
export const stanceLegend = (character) => Object.entries(stanceTable(character))
  .map(([abbr, s]) => `${s.name} (${abbr})${s.input ? `: ${s.input}` : ""}`);
