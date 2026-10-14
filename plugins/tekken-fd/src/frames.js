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

export const MOTION_INPUT_FRAMES = 2;

/**
 * Startup you can actually punish with. Wavu sometimes notes a realistic value in brackets
 * ("i11~12 (i14+)", "i11~12 (~i13)") — use it; otherwise motion inputs cost +2 frames
 * (EWGF i11 → i13: "f, df:2" takes two inputs before the button).
 */
export function effectiveStartup(key, startup) {
  const base = startupOf(startup);
  if (base === null) return null;
  const real = cleanInline(startup).match(/\(\s*~?\s*i\s*(\d+)\s*\+?\s*\)/i);
  if (real) return Math.max(base, Number(real[1]));
  return isMotionInput(key) ? base + MOTION_INPUT_FRAMES : base;
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
  if (/^(?:f,F|f,f|uf,n|b,B|b,b|u,U)/.test(k) || /[(\s]/.test(k)) return "other"; // dashes, "(Back to wall)…", "Back throw"
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
