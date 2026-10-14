// B6: frame-data quiz — questions from the index, one answer per person, everyone correct scores.
import crypto from "node:crypto";
import fs from "node:fs";
import { cleanInline, listText } from "./format.js";
import { b, code, esc } from "./render.js";

export const REVEAL_AFTER_MS = 60_000;
export const REVEAL_AFTER_ANSWERS = 8;
const KEEP_ACTIVE_MS = 24 * 60 * 60 * 1000;

const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const shuffle = (arr, rand) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** ISO week id "2026-W42". */
export function weekId(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

/** Nearby wrong answers for a numeric value (formatted with `fmt`). */
function numericOptions(value, fmt, rand, spread = [1, 2, 3, 4, 5, 6]) {
  const set = new Set([value]);
  for (const d of shuffle(spread.flatMap((x) => [x, -x]), rand)) {
    if (set.size >= 4) break;
    set.add(value + d);
  }
  return shuffle([...set], rand).map(fmt);
}

/**
 * Build a question. Types: on block, startup, throw break.
 * @returns {null | {character, moveId, key, name, type, prompt, options: string[], correct: number}}
 */
export function makeQuestion(index, { character = null, type = null, rand = Math.random } = {}) {
  const chars = index.characters().map((c) => c.name);
  const pickChar = character ?? chars[Math.floor(rand() * chars.length)];
  const types = type ? [type] : shuffle(["block", "block", "startup", "break"], rand);
  for (const t of types) {
    let pool;
    if (t === "block") pool = index.where(pickChar, "root = 1 AND throw = 0 AND block_n IS NOT NULL AND block_n BETWEEN -20 AND 8 AND stance = 'standing'");
    else if (t === "startup") pool = index.where(pickChar, "root = 1 AND throw = 0 AND startup_n IS NOT NULL AND startup_n BETWEEN 10 AND 30 AND stance = 'standing'");
    else pool = index.where(pickChar, "throw = 1 AND throw_break IN ('1', '2', '1+2')");
    if (!pool.length) continue;
    const m = pool[Math.floor(rand() * pool.length)];
    let options;
    let answer;
    let prompt;
    if (t === "block") {
      answer = signed(m.block_n);
      options = numericOptions(m.block_n, signed, rand);
      prompt = "on block?";
    } else if (t === "startup") {
      answer = `i${m.startup_n}`;
      options = numericOptions(m.startup_n, (n) => `i${n}`, rand, [1, 2, 3, 4, 5]);
      prompt = "startup?";
    } else {
      answer = m.throw_break;
      options = shuffle(["1", "2", "1+2", "1 or 2"], rand);
      prompt = "throw break?";
    }
    return {
      character: pickChar, moveId: m.id, key: m.key, name: m.name ? listText(m.name, " / ") : null,
      type: t, prompt, options, correct: options.indexOf(answer), detail: t === "block" ? cleanInline(m.block) : t === "startup" ? cleanInline(m.startup) : answer,
    };
  }
  return null;
}

export const questionHtml = (q) =>
  `🎯 ${b("Quiz")}: ${b(q.character)} ${code(q.key)}${q.name ? ` — ${esc(q.name)}` : ""}\n${b(q.prompt)}\n<i>Everyone can answer once · reveal in 60s</i>`;

export class Quiz {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return { active: {}, scores: {}, daily: {} };
    }
  }

  save(d) {
    const cutoff = this.now() - KEEP_ACTIVE_MS;
    for (const [id, q] of Object.entries(d.active)) if (q.at < cutoff) delete d.active[id];
    fs.writeFileSync(this.file, `${JSON.stringify(d, null, 2)}\n`);
  }

  create(chatId, q) {
    const d = this.load();
    const id = crypto.randomBytes(4).toString("base64url");
    d.active[id] = { ...q, chatId: String(chatId), at: this.now(), answers: {}, revealed: false, messageId: null };
    this.save(d);
    return id;
  }

  setMessage(id, messageId) {
    const d = this.load();
    if (d.active[id]) d.active[id].messageId = messageId;
    this.save(d);
  }

  get(id) {
    return this.load().active[id] ?? null;
  }

  /** @returns {{status: "accepted"|"duplicate"|"closed"|"missing", correct?: boolean, reveal?: boolean}} */
  answer(id, userId, name, choice) {
    const d = this.load();
    const q = d.active[id];
    if (!q) return { status: "missing" };
    if (q.revealed) return { status: "closed" };
    const uid = String(userId);
    if (q.answers[uid]) return { status: "duplicate" };
    const correct = choice === q.correct;
    q.answers[uid] = { choice, name, correct };
    if (correct) {
      const s = ((d.scores[q.chatId] ??= {})[uid] ??= { name, total: 0, weeks: {}, chars: {} });
      s.name = name;
      s.total++;
      s.weeks[weekId(new Date(this.now()))] = (s.weeks[weekId(new Date(this.now()))] ?? 0) + 1;
      s.chars[q.character] = (s.chars[q.character] ?? 0) + 1;
    }
    this.save(d);
    return { status: "accepted", correct, reveal: Object.keys(q.answers).length >= REVEAL_AFTER_ANSWERS };
  }

  /** Mark revealed and return the result HTML (null if already revealed / missing). */
  reveal(id) {
    const d = this.load();
    const q = d.active[id];
    if (!q || q.revealed) return null;
    q.revealed = true;
    this.save(d);
    const right = Object.values(q.answers).filter((a) => a.correct).map((a) => esc(a.name));
    const wrong = Object.values(q.answers).filter((a) => !a.correct).map((a) => `${esc(a.name)} (${esc(q.options[a.choice])})`);
    return [
      `🎯 ${b("Quiz")}: ${b(q.character)} ${code(q.key)}${q.name ? ` — ${esc(q.name)}` : ""} — ${esc(q.prompt)}`,
      `✅ ${b(q.options[q.correct])}${q.detail && q.detail !== q.options[q.correct] ? ` <i>(${esc(q.detail)})</i>` : ""}`,
      right.length ? `🏆 ${right.join(", ")}` : "🏆 nobody got it",
      wrong.length ? `❌ ${wrong.join(", ")}` : "",
    ].filter(Boolean).join("\n");
  }

  /** Unrevealed questions older than the reveal delay (for restarts). */
  overdue() {
    return Object.entries(this.load().active)
      .filter(([, q]) => !q.revealed && this.now() - q.at >= REVEAL_AFTER_MS)
      .map(([id, q]) => ({ id, chatId: q.chatId, messageId: q.messageId }));
  }

  leaderboard(chatId, { character = null } = {}) {
    const scores = Object.values(this.load().scores[String(chatId)] ?? {});
    const wk = weekId(new Date(this.now()));
    const val = (s) => (character ? s.chars[character] ?? 0 : s.total);
    const all = scores.filter((s) => val(s) > 0).sort((x, y) => val(y) - val(x)).slice(0, 10);
    const week = scores.filter((s) => (s.weeks[wk] ?? 0) > 0).sort((x, y) => (y.weeks[wk] ?? 0) - (x.weeks[wk] ?? 0)).slice(0, 10);
    const medal = (i) => ["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`;
    return [
      `🏆 ${b(`Quiz leaderboard${character ? ` — ${character}` : ""}`)}`,
      b("All time"), all.length ? all.map((s, i) => `${medal(i)} ${esc(s.name)} — ${val(s)}`).join("\n") : "no correct answers yet",
      ...(character ? [] : [b(`This week (${wk})`), week.length ? week.map((s, i) => `${medal(i)} ${esc(s.name)} — ${s.weeks[wk]}`).join("\n") : "—"]),
    ].join("\n");
  }

  /** Daily auto-quiz bookkeeping: true once per local day per chat when time ≥ dailyAt. */
  dueDaily(chatId, { dailyAt = "19:00", tz = "Europe/Moscow" } = {}) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(this.now())).map((p) => [p.type, p.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const hm = `${parts.hour}:${parts.minute}`;
    const d = this.load();
    if (hm < dailyAt || d.daily?.[String(chatId)] === today) return false;
    // don't fire late at night after a long outage: only within 6h of the slot
    const [h, m] = dailyAt.split(":").map(Number);
    const mins = Number(parts.hour) * 60 + Number(parts.minute) - (h * 60 + m);
    if (mins > 6 * 60) return false;
    (d.daily ??= {})[String(chatId)] = today;
    this.save(d);
    return true;
  }
}
