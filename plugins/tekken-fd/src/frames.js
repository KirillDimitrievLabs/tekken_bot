// Parse Wavu frame strings into numbers/flags for punish, unsafe and list queries.
import { cleanInline } from "./format.js";

/** First startup frame: "i15~16" → 15, "i13 i24" → 13, "i12-14" → 12; null if none. */
export function startupOf(value) {
  const m = cleanInline(value).match(/i\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

const DIRECTION = /^(?:[udfbn]|d[fb]|u[fb])$/i;

/** Motion input before the button: "f,n,d,df+2", "f,n,d,df:2", "qcf+1", "b,f+2", "d,df+1" (not strings like "1,2"). */
export function isMotionInput(key) {
  const k = String(key ?? "").trim();
  if (/^(?:qc[fb]|hc[fb]|dp)/i.test(k)) return true;
  for (const t of k.split(",")) {
    const tok = t.trim();
    if (/\d/.test(tok)) return false;
    if (DIRECTION.test(tok)) return true;
  }
  return false;
}

const BUFFERABLE = /\b(?:can be buffered|input bufferable|bufferable|completely bufferable)\b/i;
const NOT_BUFFERABLE = /cannot be buffered/i;

/** Directions entered before the final one: "qcf" → 2, "b,f+2" → 1, "f,n,b+2" → 2. */
function priorDirections(key) {
  const k = String(key ?? "").trim();
  const circle = k.match(/^(qc[fb]|hc[fb])/i);
  if (circle) return circle[1].toLowerCase().startsWith("qc") ? 2 : 4;
  let n = 0;
  for (const t of k.split(",")) {
    const tok = t.trim();
    if (/\d/.test(tok)) break;
    if (DIRECTION.test(tok)) n++;
  }
  return n;
}

/**
 * Startup you can actually punish with, and how it was derived (for the !punish line).
 * Sources: Wavu "Input buffer" — bufferable motions only need the final input inside the
 * 8-frame buffer, so earlier directions are free during blockstun; owner-confirmed timings
 * for the wind god fist family and f,b / f,n,b launchers.
 *   f,n,d,df+X / f,n,d,df:X (WGF/EWGF): shortcut f,n,df / f,d,df = +2, full motion +4 / +3
 *   f,b+X · f,n,b+X (Jet Upper type): bufferable, +0
 *   Wavu note "Can be buffered"/"Bufferable": +0
 *   Wavu realistic bracket ("i11~12 (i14+)"): that value
 *   other motions (no buffering info): +1 per direction before the final one, marked ≈
 * @returns {{eff: number|null, note: string}}
 */
export function inputTiming(key, move = {}) {
  const base = startupOf(move.startup);
  if (base === null) return { eff: null, note: "" };
  const k = String(key ?? "");
  const info = [move.notes, move.alias, move.alt].filter(Boolean).join(" ");
  if (/^f,n,d,df[+:]/i.test(k)) {
    const full = base + (k.includes(":") ? 3 : 4);
    return { eff: base + 2, note: `(i${base}: i${base + 2} as f,n,df / f,d,df · i${full} full motion)` };
  }
  if (/^f,(?:n,)?b[+:]/i.test(k)) return { eff: base, note: "" };
  if (!isMotionInput(k)) return { eff: base, note: "" };
  if (BUFFERABLE.test(info) && !NOT_BUFFERABLE.test(info)) return { eff: base, note: "(bufferable)" };
  const real = cleanInline(move.startup).match(/\(\s*~?\s*i\s*(\d+)\s*\+?\s*\)/i);
  if (real) return { eff: Math.max(base, Number(real[1])), note: `(i${base}, realistic per Wavu)` };
  const extra = priorDirections(k);
  return { eff: base + extra, note: `(≈ i${base} + ${extra} for the motion)` };
}

/** @deprecated kept for callers that only need the number */
export function effectiveStartup(key, startup, move = {}) {
  return inputTiming(key, { ...move, startup }).eff;
}

/**
 * Guaranteed on-block frames: "-12" → -12, "-14~-13" → -13 (the attacker's best case),
 * "+5c" → 5, "-9~+1" → 1; "!" (unblockable) and unparseable → null.
 */
export function blockOf(value) {
  const nums = (cleanInline(value).match(/[+-]?\d+/g) ?? []).map(Number);
  return nums.length ? Math.max(...nums) : null;
}

/** Launches on normal hit: "+38a (+30)", "+67a", "+5a" (a = airborne). */
export function isLauncher(hit) {
  return /^[+-]?\d+(?:~[+-]?\d+)?a\b/i.test(cleanInline(hit));
}

/** First hit level of the move: "m,h" → "m", "L" → "l", "t" → "t" (throw). */
export function hitLevelOf(target) {
  const first = cleanInline(target).replace(/^,/, "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first || null;
}

/** Hit levels of every hit ("h,m,l" → ["h","m","l"]). */
export function hitLevelsOf(target) {
  return cleanInline(target).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Where a root move can be done from, for punishing:
 *   "standing"  — plain inputs (1,2 · df+1 · d+3+4 · b+1 · u/f inputs)
 *   "crouching" — while standing up / full crouch (ws2 · FC.df+1)
 *   "other"     — stances, dashes, heat/rage-only, situational (BT. SS. H. R. f,F f,f,F uf,n …)
 */
export function stanceOf(key) {
  const k = String(key ?? "").trim();
  if (/^ws/i.test(k) || /^FC\./.test(k)) return "crouching";
  if (/^[A-Za-z]{2,}\./.test(k) || /^[A-Z]\./.test(k)) return "other"; // BT. SS. H. R. hFC. …
  if (/^(?:f,F|f,f|uf,n|b,B|b,b|u,U|wr|WR)/.test(k) || /[(\s]/.test(k)) return "other"; // dashes, "(Back to wall)…", "Back throw"
  return "standing";
}

/** Throw: first hit level "t", "th(h)", "t(g)". */
export function isThrow(target) {
  return /^t/.test(hitLevelOf(target) ?? "");
}

/** Level class of one hit: "low" | "mid" | "high" | "throw" | null. Uppercase = also hits grounded. */
export function levelClass(level) {
  const l = String(level ?? "").toLowerCase().replace(/!$/, "");
  if (/^t/.test(l)) return "throw";
  if (/^s?l/.test(l)) return "low";
  if (/^s?m/.test(l)) return "mid";
  if (/^h/.test(l)) return "high";
  return null;
}

/** Unblockable hit ("m!", "h!") or block "!". */
export function isUnblockable(target, block) {
  return /!/.test(cleanInline(target)) || cleanInline(block) === "!";
}

/** Total damage of a single move's own hits ("10,12" → 22). */
export function damageOf(value) {
  return (cleanInline(value).match(/\d+/g) ?? []).map(Number).reduce((a, b) => a + b, 0);
}

/** Knockdown or launch on that outcome ("+43d (+35)", "+38a"). */
export function isKnockdown(value) {
  return /^[+-]?\d+(?:~[+-]?\d+)?[ad]/i.test(cleanInline(value));
}

/** "r27", "r21 FC" → 27; null if unknown. */
export function recoveryOf(value) {
  const m = cleanInline(value).match(/r\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/** Total frames "86", "71?" → 86. */
export function totalOf(value) {
  const m = cleanInline(value).match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

export function reachOf(value) {
  const n = Number.parseFloat(cleanInline(value));
  return Number.isFinite(n) ? n : null;
}

/** Plus on hit (any positive first number). */
export function hitAdvantageOf(value) {
  const m = cleanInline(value).match(/^([+-]?\d+)/);
  return m ? Number(m[1]) : null;
}
