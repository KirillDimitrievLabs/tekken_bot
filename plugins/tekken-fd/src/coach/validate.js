import { guideSchema } from "./prompt.js";

const REF = /\[\[([^\[\]\r\n]+)\]\]/g;
const EXACT_REF = /^\[\[([^\[\]\r\n]+)\]\]$/;
const NUMBER = /(?:\bi)?[+−-]?\p{N}+(?:[.,~–-]\p{N}+)*(?:f|st|nd|rd|th|%|ф)?/gu;
// Cardinals are numeric claims; ordinals are allowed for naming a string's hit ("duck the second hit",
// "второй удар") but not for frames/damage/time.
const RU_CARDINAL = "ноль|один|одна|одно|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто|сто";
const WORD_NUMBER = new RegExp([
  String.raw`\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\s+(?:frames?|damage|hits?|seconds?|percent)\b`,
  String.raw`\b(?:first|second|third|fourth|fifth)\s+(?:frames?|damage|seconds?|percent)\b`,
  String.raw`(?<!\p{L})(?:${RU_CARDINAL})\s+(?:кадр|урон|удар|хит|секунд|процент)\p{L}*`,
  String.raw`(?<!\p{L})(?:перв|втор|трет)\p{L}*\s+(?:кадр|урон|секунд|процент)\p{L}*`,
].join("|"), "giu");
const FILLER = /\bbe patient\b|\bplay smart\b|\bjust block\b|будь(?:те)? терпелив|игра(?:й|йте) умн|просто блокиру/iu;
export const ACTIONS = {
  crouch_block: /crouch(?:ing)?[- _]block|block (?:the )?low|блок\p{L}* сидя|блок\p{L}* (?:лоу|низ)|блок\p{L}* (?:в )?присед/iu,
  punish: /punish|накаж|наказ/iu,
  interrupt: /interrupt|переби|перебе|перебь/iu,
  duck: /\bduck\b|прис(?:есть|ед)|пригни/iu,
  SSL: /\bSSL\b|step left|степ\p{L}* влево|шаг\p{L}* влево/iu,
  SSR: /\bSSR\b|step right|степ\p{L}* вправо|шаг\p{L}* вправо/iu,
  SWL: /\bSWL\b|walk left|обход\p{L}* влево/iu,
  SWR: /\bSWR\b|walk right|обход\p{L}* вправо/iu,
};

export const refsOf = (value) => [...String(value ?? "").matchAll(REF)].map((m) => m[1]);
const tokenId = (value) => String(value ?? "").match(EXACT_REF)?.[1] ?? null;
const own = (x, k) => Object.prototype.hasOwnProperty.call(x, k);
const plain = (x) => x && typeof x === "object" && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);

function canonicalAction(value) {
  const v = String(value).trim();
  if (own(ACTIONS, v)) return v;
  if (/crouch|low block/i.test(v)) return "crouch_block";
  for (const [action, pattern] of Object.entries(ACTIONS)) if (pattern.test(v)) return action;
  return null;
}

function supportedEscape(candidate, answer, moves, as) {
  const refs = refsOf(answer);
  const supported = new Set((candidate.actions ?? []).map(canonicalAction).filter(Boolean));
  const observed = Object.entries(ACTIONS).filter(([, pattern]) => pattern.test(answer)).map(([action]) => action);
  // Crouch block is not a string duck; recognize its combined phrasing only as block.
  const actual = observed.filter((a) => !(a === "duck" && observed.includes("crouch_block")));
  if (actual.some((a) => !supported.has(a))) return false;
  const yourRefs = refs.filter((id) => as && moves.get(id)?.character === as);
  if (yourRefs.some((id) => id !== candidate.answer)) return false;
  if (candidate.answer && (actual.includes("punish") || actual.includes("interrupt")) && !refs.includes(candidate.answer)) return false;
  if (candidate.answer && refs.includes(candidate.answer)) return actual.length > 0;
  return actual.some((a) => supported.has(a));
}

/** Reject invented facts rather than blessing a number seen on an unrelated move. */
export function validateGuide(raw, dossier) {
  const errors = [];
  const strippedNumbers = [];
  let guide;
  try {
    const json = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (json?.length > 40000) throw new Error("JSON exceeds size limit");
    guide = JSON.parse(json);
  } catch (e) {
    return { ok: false, guide: null, errors: [`Invalid JSON: ${e.message}`], strippedNumbers };
  }
  if (!plain(guide)) return { ok: false, guide: null, errors: ["Guide must be a JSON object"], strippedNumbers };
  const schema = guideSchema(dossier.mode);
  const moves = dossier.moves instanceof Map ? dossier.moves : new Map(Object.entries(dossier.moves ?? {}));
  const sides = new Set([dossier.as, dossier.opponent].filter(Boolean));
  const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = [...new Set([...(dossier.characterNames ?? []), ...sides, "Tekken 8"])].filter((n) => /\p{N}/u.test(n)).sort((a, b) => b.length - a.length);
  const NAMES = names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "giu") : null;

  function checkText(value, path, max = 900, exemptNumbers = false) {
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`${path} must be a nonempty string`);
      return value;
    }
    if (value.length > max) errors.push(`${path} exceeds ${max} characters`);
    if (exemptNumbers) return value;
    if (FILLER.test(value)) errors.push(`${path} contains generic filler`);
    const refs = refsOf(value);
    for (const id of refs) {
      const move = moves.get(id);
      if (!move) errors.push(`${path}: unknown move [[${id}]]`);
      else if (!sides.has(move.character)) errors.push(`${path}: move [[${id}]] belongs to an unrelated character`);
    }
    const withoutRefs = value.replace(REF, "");
    if (/\[\[|\]\]/.test(withoutRefs)) errors.push(`${path}: malformed move reference`);
    const prose = NAMES ? withoutRefs.replace(NAMES, " ") : withoutRefs;
    if (refs.length > 12) errors.push(`${path}: too many move references`);
    const claims = [...prose.matchAll(NUMBER), ...prose.matchAll(WORD_NUMBER)].map((m) => m[0]);
    if (!claims.length) return value;
    for (const claim of claims) strippedNumbers.push({ path, value: claim });
    errors.push(`${path}: numeric prose is forbidden; use move references for facts`);
    // Sanitized guide is diagnostic only until ok=true. Preserve references atomically.
    return value.split(/(\[\[[^\[\]\r\n]+\]\])/).map((part) => EXACT_REF.test(part) ? part : part.replace(NUMBER, "…").replace(WORD_NUMBER, "…")).join("");
  }

  for (const key of Object.keys(guide)) if (!own(schema, key)) errors.push(`Unexpected field ${key}`);
  for (const [key, description] of Object.entries(schema)) {
    if (!own(guide, key)) { errors.push(`Missing field ${key}`); continue; }
    if (!Array.isArray(description)) {
      guide[key] = checkText(guide[key], key, key === "summary" ? 600 : 900);
      continue;
    }
    const values = guide[key];
    if (!Array.isArray(values)) { errors.push(`${key} must be an array`); continue; }
    if (values.length > 7) errors.push(`${key} has more than seven items`);
    const itemSchema = description[0];
    for (let i = 0; i < values.length; i++) {
      const path = `${key}[${i}]`;
      if (typeof itemSchema === "string") {
        values[i] = checkText(values[i], path, key.startsWith("used_") ? 160 : 900, key.startsWith("used_"));
        continue;
      }
      if (!plain(values[i])) { errors.push(`${path} must be an object`); continue; }
      for (const k of Object.keys(values[i])) if (!own(itemSchema, k)) errors.push(`${path}: unexpected field ${k}`);
      for (const k of Object.keys(itemSchema)) {
        if (!own(values[i], k)) { errors.push(`${path}: missing ${k}`); continue; }
        values[i][k] = checkText(values[i][k], `${path}.${k}`, k === "move" ? 180 : 900);
      }
      if (values[i].move !== undefined) {
        const id = tokenId(values[i].move);
        const expected = ["your_best_tools", "stop_doing"].includes(key) ? dossier.as : dossier.opponent;
        if (!id) errors.push(`${path}.move must be a single exact move reference`);
        else if (moves.has(id) && moves.get(id).character !== expected) errors.push(`${path}.move belongs to the wrong side (expected ${expected})`);
      }
      if (key === "punish" && dossier.mode !== "matchup" && !["high", "med"].includes(values[i].priority)) errors.push(`${path}.priority must be high or med`);
    }
  }
  if (!["high", "medium", "low"].includes(guide.confidence)) errors.push("confidence must be high, medium or low");
  const coverage = typeof dossier.coverage === "string" ? dossier.coverage : dossier.coverage?.level;
  if (coverage === "sparse" && (guide.confidence !== "low" || !guide.gaps?.length)) errors.push("Sparse evidence requires low confidence and an explicit gap");
  for (const [field, allowed] of [["used_tips", dossier.tipIds], ["used_guides", dossier.guideIds]]) {
    for (const id of Array.isArray(guide[field]) ? guide[field] : []) if (!(allowed ?? []).includes(id)) errors.push(`${field}: unknown source ${String(id)}`);
    if (Array.isArray(guide[field]) && new Set(guide[field]).size !== guide[field].length) errors.push(`${field}: duplicate source IDs`);
  }
  if (!Array.isArray(guide.lab_drill) || !guide.lab_drill.length) errors.push("lab_drill must contain a concrete practice instruction");
  const gk = dossier.generalKnowledge ?? { allowed: false, max: 0 };
  if (Array.isArray(guide.general_knowledge) && guide.general_knowledge.length > (gk.allowed ? gk.max : 0)) {
    errors.push(gk.allowed ? `general_knowledge allows at most ${gk.max} items` : "general_knowledge must be empty: the written guides are rich enough");
  }

  const punish = Array.isArray(guide.punish) ? guide.punish.filter(plain) : [];
  const computedPunishes = new Map([...(dossier.interactions?.I1 ?? []), ...(dossier.requiredUnsafe ?? [])].map((r) => [r.move, r]));
  for (const item of punish) {
    const subject = tokenId(item.move);
    const computed = computedPunishes.get(subject);
    if (dossier.mode === "matchup" && !computed) errors.push(`punish [[${subject}]] has no computed relation in the dossier`);
    if (dossier.mode === "matchup" && computed) {
      if (refsOf(item.answer).some((id) => moves.has(id) && moves.get(id).character !== dossier.as)) errors.push(`punish [[${subject}]] answer belongs to the wrong side`);
      const yourRefs = refsOf(item.answer).filter((id) => moves.get(id)?.character === dossier.as);
      if (yourRefs.some((id) => id !== computed.answer)) errors.push(`punish [[${subject}]] cites an answer unsupported by its computed relation`);
    }
  }
  const reverse = new Map((dossier.interactions?.I2 ?? []).map((r) => [r.move, r]));
  for (const item of Array.isArray(guide.stop_doing) ? guide.stop_doing.filter(plain) : []) {
    const relation = reverse.get(tokenId(item.move));
    const enemyRefs = refsOf(item.why).filter((id) => moves.get(id)?.character === dossier.opponent);
    if (enemyRefs.length && (!relation?.answer || enemyRefs.some((id) => id !== relation.answer))) errors.push(`stop_doing ${item.move} cites an unsupported reverse punish`);
  }
  for (const required of dossier.requiredUnsafe ?? []) {
    const item = punish.find((p) => tokenId(p.move) === required.move);
    if (!item) { errors.push(`punish must cover unsafe [[${required.move}]]`); continue; }
    if (dossier.mode === "matchup") {
      const yourRefs = refsOf(item.answer).filter((id) => moves.get(id)?.character === dossier.as);
      if (required.answer && (!yourRefs.includes(required.answer) || yourRefs.some((id) => id !== required.answer))) errors.push(`punish [[${required.move}]] must use the computed answer [[${required.answer}]]`);
      if (!required.answer && yourRefs.length) errors.push(`punish [[${required.move}]] has no computed eligible answer; report the gap`);
      if (!required.answer && (!guide.gaps?.length || !/no |not |unknown|missing|нет|не |неизвест|недостат|отсутств/iu.test(`${item.answer} ${item.note}`))) errors.push(`punish [[${required.move}]] must explicitly acknowledge missing evidence`);
    } else if (!ACTIONS.punish.test(item.answer)) errors.push(`punish [[${required.move}]] must state a block-punish answer`);
  }

  // Coverage counts distinct threats whose answer action agrees with that threat's evidence.
  const candidates = dossier.escapeAnswers ?? [];
  const entries = [
    ...(Array.isArray(guide.defense) ? guide.defense.filter(plain).map((x) => ({ subjects: refsOf(x.situation), answer: x.answer })) : []),
    ...(Array.isArray(guide.lows) ? guide.lows.filter(plain).map((x) => ({ subjects: [tokenId(x.move)], answer: x.answer })) : []),
  ];
  const covered = new Set();
  for (const entry of entries) {
    for (const id of entry.subjects) {
      const candidate = candidates.find((c) => c.move === id);
      if (!candidate) continue;
      if (supportedEscape(candidate, String(entry.answer ?? ""), moves, dossier.as)) covered.add(id);
      else errors.push(`defense [[${id}]] must use that threat's supported action or punish answer`);
    }
  }
  const minimum = Math.min(3, new Set(candidates.map((x) => x.move)).size);
  if (covered.size < minimum) errors.push(`Need ${minimum} distinct evidence-backed string/low answers; found ${covered.size}`);
  return { ok: errors.length === 0, guide, errors: [...new Set(errors)], strippedNumbers };
}
