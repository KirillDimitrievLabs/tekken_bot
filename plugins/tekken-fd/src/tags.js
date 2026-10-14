// Property tags for !list filters, derived from notes, crush, hit and block fields at index build.
import { blockOf, damageOf, hitAdvantageOf, hitLevelOf, hitLevelsOf, isKnockdown, isLauncher, isMotionInput, isThrow, isUnblockable, levelClass, startupOf, stanceOf } from "./frames.js";
import { cleanInline, listText, noteItems } from "./format.js";

// note item (prefix, case-insensitive) → tag
const NOTE_TAGS = [
  ["homing", "homing"], ["tornado", "tornado"], ["balcony break", "balcony"], ["floor break", "floor"],
  ["wall crush", "wall"], ["spike", "spike"], ["heat engager", "engager"], ["heat smash", "smash"],
  ["heat burst", "burst"], ["heat dash", "heatdash"], ["rage art", "rage"], ["elbow", "elbow"], ["knee", "knee"],
  ["weapon", "weapon"], ["reversal break", "reversalbreak"], ["guard break", "guardbreak"], ["power crush", "powercrush"],
];

/** "Combo from 1st hit", "Airborne combo from first hit (+17a)", "Combos from the 1st hit" */
export const COMBO_FROM_FIRST = /\bcombos? from (?:the )?(?:1st|first) hit\b/i;

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
  // Wavu "Standard move" archetypes (https://wavu.wiki/t/Standard_move)
  "magic four": "magicfour", "magic 4": "magicfour", magic4: "magicfour", "magic fours": "magicfour",
  hopkick: "hopkick", "hop kick": "hopkick", hopkicks: "hopkick",
  orbital: "orbital", "orbital heel": "orbital", orbitals: "orbital",
  hellsweep: "hellsweep", "hell sweep": "hellsweep", hellsweeps: "hellsweep",
  "snake edge": "snakeedge", snakeedge: "snakeedge", "snake edges": "snakeedge",
  "power low": "powerlow", "power lows": "powerlow",
  "shadow cutter": "shadowcutter", "shadow cutters": "shadowcutter",
  "stature kick": "staturekick", "stature kicks": "staturekick",
  "clef cannon": "clefcannon", "clef cannons": "clefcannon",
  "slash kick": "slashkick", "slash kicks": "slashkick",
  "mid check": "midcheck", "mid checks": "midcheck",
  // tracking (Wavu notes / fields; sparse)
  "tracks left": "tracksleft", "left tracking": "tracksleft", "tracks right": "tracksright", "right tracking": "tracksright",
  "step left": "ssl", ssl: "ssl", "step right": "ssr", ssr: "ssr", steppable: "ssr", duckable: "duckable", ducks: "duckable",
};

export const FILTER_LABELS = {
  low: "lows", mid: "mids", high: "highs", homing: "homing", tornado: "tornado", balcony: "balcony break",
  floor: "floor break", wall: "wall crush", spike: "spike", engager: "heat engagers", smash: "heat smash",
  burst: "heat burst", heatdash: "heat dash", heat: "heat moves", rage: "rage art", elbow: "elbows", knee: "knees",
  weapon: "weapon", reversalbreak: "reversal break", guardbreak: "guard break", powercrush: "power crush",
  lowcrush: "low crush (js)", highcrush: "high crush (cs)", launcher: "launchers", throw: "throws",
  unblockable: "unblockable", plus: "plus on block", safe: "safe on block (≥ −9)",
  magicfour: "magic fours", hopkick: "hopkicks", orbital: "orbitals", hellsweep: "hellsweeps",
  snakeedge: "snake edges", powerlow: "power lows", shadowcutter: "shadow cutters", staturekick: "stature kicks",
  clefcannon: "clef cannons", slashkick: "slash kicks", midcheck: "mid checks",
  tracksleft: "good left tracking", tracksright: "good right tracking",
  ssl: "whiff vs sidestep left", ssr: "whiff vs sidestep right", swl: "whiff vs sidewalk left", swr: "whiff vs sidewalk right", duckable: "duckable",
};

/** Archetype rules after Wavu's "Standard move" definitions; `root` = first move of the chain. */
export function archetypesFor(move, key, root = move, kids = []) {
  const out = [];
  const isRoot = !move.parent;
  const level = levelClass(hitLevelOf(move.target));
  const startup = startupOf(root.startup);
  const block = cleanInline(move.block) === "!" ? null : blockOf(move.block);
  const crush = listText(move.crush, " ").toLowerCase();
  const launch = isLauncher(move.hit);
  const down = isKnockdown(move.hit);
  const chLaunch = isLauncher(move.ch) || launch;
  const notes = noteItems(move.notes).map((n) => n.toLowerCase());
  const standing = stanceOf(key) === "standing";
  const plain = standing && !isMotionInput(key); // neutral inputs only (uf+4, b+3, 4 …)
  // knockdown either directly or through a follow-up that combos from the 1st hit (Mishima f,n,d,DF+4,1)
  const downOrFollowUp = down || kids.some((c) => (isLauncher(c.hit) || isKnockdown(c.hit))
    && noteItems(c.notes).some((n) => COMBO_FROM_FIRST.test(n)));
  const running = /^(?:f,F|f,f,F|wr)/i.test(key);
  if (isRoot) {
    if (level === "high" && startup >= 11 && startup <= 13 && chLaunch && plain) out.push("magicfour");
    if (level === "mid" && /\bjs\d/.test(crush) && launch && startup !== null && startup <= 16 && block !== null && block <= -10 && plain) out.push("hopkick");
    if (level === "mid" && /\bjs\d/.test(crush) && launch && block !== null && block >= -9 && plain) out.push("orbital");
    if (level === "low" && downOrFollowUp && block !== null && block <= -15 && startup !== null && startup <= 20 && standing) out.push("hellsweep");
    if (level === "low" && startup !== null && startup >= 20 && (launch || down) && standing) out.push("snakeedge");
    if (level === "low" && damageOf(move.damage) >= 20 && downOrFollowUp && standing) out.push("powerlow");
    if (level === "low" && /\bcs\d/.test(crush) && isLauncher(move.ch) && standing) out.push("shadowcutter");
    const plusOnHit = hitAdvantageOf(move.hit);
    if (level === "low" && standing && startup !== null && startup <= 16 && plusOnHit !== null && plusOnHit > 0 && block !== null && block >= -14) out.push("staturekick");
    if (level === "mid" && standing && startup >= 13 && startup <= 15 && block !== null && block >= -9) out.push("midcheck");
    if (running && level === "mid" && block !== null && block > 0 && down) out.push("slashkick");
  } else if (levelClass(hitLevelOf(root.target)) === "high" && startupOf(root.startup) === 10
      && notes.some((n) => /^combos? from 1st ch\b/.test(n)) && !notes.some((n) => /^combos? from 1st hit\b/.test(n))) {
    out.push("clefcannon");
  }
  return out;
}

export function resolveFilter(text) {
  const t = String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return FILTERS[t] ?? FILTERS[t.replace(/s$/, "")] ?? null;
}

/** Tags of one move (its own hit for level tags). */
export function tagsFor(move, key, root = move, kids = []) {
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
  if (items.some((n) => /good left (?:sidestep )?tracking|tracks left/.test(n)) || Number(move.tracksLeft) > 0) tags.add("tracksleft");
  if (items.some((n) => /good right (?:sidestep )?tracking|tracks right/.test(n)) || Number(move.tracksRight) > 0) tags.add("tracksright");
  // Wavu notes: "Whiffs vs SSR from 1st block", "Whiffs vs SS, SW", "Duckable", "String duckable"
  for (const n of items) {
    const w = n.match(/whiffs? (?:vs|against) ([a-z ,\/]+)/i);
    if (w) {
      for (const side of w[1].toUpperCase().split(/[\s,\/]+/)) {
        if (side === "SS") tags.add("ssl").add("ssr");
        else if (["SSL", "SSR", "SWL", "SWR"].includes(side)) tags.add(side.toLowerCase());
        else if (side === "SW") tags.add("swl").add("swr");
      }
    }
    if (/\bduckable\b/.test(n)) tags.add("duckable");
  }
  for (const a of archetypesFor(move, key, root, kids)) tags.add(a);
  return [...tags];
}

export { stanceOf };
