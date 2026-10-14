// Property tags for !list filters, derived from notes, crush, hit and block fields at index build.
import { blockOf, hitLevelsOf, isLauncher, isThrow, isUnblockable, levelClass, stanceOf } from "./frames.js";
import { cleanInline, listText, noteItems } from "./format.js";

// note item (prefix, case-insensitive) → tag
const NOTE_TAGS = [
  ["homing", "homing"], ["tornado", "tornado"], ["balcony break", "balcony"], ["floor break", "floor"],
  ["wall crush", "wall"], ["spike", "spike"], ["heat engager", "engager"], ["heat smash", "smash"],
  ["heat burst", "burst"], ["heat dash", "heatdash"], ["rage art", "rage"], ["elbow", "elbow"], ["knee", "knee"],
  ["weapon", "weapon"], ["reversal break", "reversalbreak"], ["guard break", "guardbreak"], ["power crush", "powercrush"],
];

/** Filter words users type → tag id. */
export const FILTERS = {
  low: "low", lows: "low", mid: "mid", mids: "mid", high: "high", highs: "high",
  homing: "homing", homings: "homing", tornado: "tornado", tornados: "tornado", screw: "tornado",
  balcony: "balcony", "balcony break": "balcony", floor: "floor", "floor break": "floor",
  wall: "wall", "wall crush": "wall", spike: "spike", spikes: "spike",
  engager: "engager", engagers: "engager", "heat engager": "engager", "heat engagers": "engager",
  smash: "smash", "heat smash": "smash", burst: "burst", "heat burst": "burst", "heat dash": "heatdash",
  heat: "heat", "heat moves": "heat", rage: "rage", "rage art": "rage",
  elbow: "elbow", elbows: "elbow", knee: "knee", knees: "knee", weapon: "weapon", weapons: "weapon",
  "reversal break": "reversalbreak", "guard break": "guardbreak",
  pc: "powercrush", "power crush": "powercrush", "power crushes": "powercrush", powercrush: "powercrush",
  "low crush": "lowcrush", jumps: "lowcrush", js: "lowcrush", "high crush": "highcrush", crouch: "highcrush", cs: "highcrush",
  launcher: "launcher", launchers: "launcher", throw: "throw", throws: "throw", grab: "throw", grabs: "throw",
  unblockable: "unblockable", unblockables: "unblockable", plus: "plus", "plus on block": "plus", safe: "safe",
};

export const FILTER_LABELS = {
  low: "lows", mid: "mids", high: "highs", homing: "homing", tornado: "tornado", balcony: "balcony break",
  floor: "floor break", wall: "wall crush", spike: "spike", engager: "heat engagers", smash: "heat smash",
  burst: "heat burst", heatdash: "heat dash", heat: "heat moves", rage: "rage art", elbow: "elbows", knee: "knees",
  weapon: "weapon", reversalbreak: "reversal break", guardbreak: "guard break", powercrush: "power crush",
  lowcrush: "low crush (js)", highcrush: "high crush (cs)", launcher: "launchers", throw: "throws",
  unblockable: "unblockable", plus: "plus on block", safe: "safe on block (≥ −9)",
};

export function resolveFilter(text) {
  const t = String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return FILTERS[t] ?? FILTERS[t.replace(/s$/, "")] ?? null;
}

/** Tags of one move (its own hit for level tags). */
export function tagsFor(move, key) {
  const tags = new Set();
  const items = noteItems(move.notes).map((s) => s.toLowerCase());
  for (const [prefix, tag] of NOTE_TAGS) if (items.some((it) => it.startsWith(prefix))) tags.add(tag);
  const crush = listText(move.crush, " ").toLowerCase();
  if (/\bpc\d/.test(crush)) tags.add("powercrush");
  if (/\bjs\d/.test(crush)) tags.add("lowcrush");
  if (/\bcs\d/.test(crush)) tags.add("highcrush");
  const own = hitLevelsOf(move.target).at(-1);
  const cls = levelClass(own);
  if (cls && cls !== "throw") tags.add(cls);
  if (isThrow(move.target) || cls === "throw") tags.add("throw");
  if (isLauncher(move.hit)) tags.add("launcher");
  if (isUnblockable(move.target, move.block)) tags.add("unblockable");
  const b = cleanInline(move.block) === "!" ? null : blockOf(move.block);
  if (b !== null && b > 0) tags.add("plus");
  if (b !== null && b >= -9) tags.add("safe");
  if (/^H\./.test(key)) tags.add("heat");
  return [...tags];
}

export { stanceOf };
