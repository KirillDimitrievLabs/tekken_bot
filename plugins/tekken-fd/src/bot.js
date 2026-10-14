// Command router: message text → replies (Telegram HTML + abstract button actions). No I/O here;
// index.js does transport (sending, tokens, alias flows, quiz timers).
import { analyze, parseCharacterArgs, splitQuery } from "./fastpath.js";
import { cleanInline } from "./format.js";
import { formatString, formatCharacterGaps } from "./gaps.js";
import { formatBeat, formatSidestep } from "./evasion.js";
import { formatMatchup } from "./matchup.js";
import { fixLayout } from "./nicknames.js";
import { filterHelp, formatHeat, formatList, formatPunish, formatUnsafe, formatWall, minus, resolveFilter } from "./queries.js";
import { questionHtml, makeQuestion } from "./quiz.js";
import { b, cardHtml, code, details, mk, esc, isWellFormed, LEGEND_HTML } from "./render.js";
import { splitHtml } from "./coach/render.js";
import { resolveCharacter, resolveMove } from "./resolve.js";
import { formatThrows } from "./throws.js";
import { formatWhiff } from "./whiff.js";
import { prettyKey } from "./stances.js";
import { parseCoachTarget, parseTip } from "./coach/commands.js";

export const COMMANDS = ["fd", "punish", "unsafe", "list", "help", "legend", "main", "mains", "mu", "gaps", "ss", "beat", "whiff", "throws", "quiz", "top", "heat", "wall", "vs", "coach", "coachlang", "coachlevel", "tip", "tips", "mytips"];
const COMMAND_RE = new RegExp(`^\\s*(?:@\\w+\\s+)?!(${COMMANDS.join("|")})\\b\\s*([\\s\\S]*)$`, "i");
export const MENTION_PATTERN = `^\\s*!(${COMMANDS.join("|")})\\b`;
const MAX_MULTI = 5;
// raw HTML per page; visible text is shorter, so pages stay under Telegram's 4096 limit with the page title
const PAGE_LIMIT = 3400;

/** "!fd kaz df1; jin d3\n!punish lars 14" → [{cmd, args}…] (segments inherit the previous command). */
export function parseCommands(text) {
  const m = COMMAND_RE.exec(String(text ?? ""));
  if (!m) return [];
  // Tip prose may contain semicolons and line breaks; keep it as one submission.
  if (m[1].toLowerCase() === "tip") return [{ cmd: "tip", args: m[2].trim() }];
  const out = [];
  let cmd = m[1].toLowerCase();
  for (const raw of m[2].split(/[;\n]/)) {
    const seg = raw.trim();
    const own = COMMAND_RE.exec(seg);
    if (own) {
      cmd = own[1].toLowerCase();
      out.push({ cmd, args: own[2].replace(/\s+/g, " ").trim() });
    } else if (seg || !out.length) {
      out.push({ cmd, args: seg.replace(/\s+/g, " ") });
    }
  }
  return out.slice(0, MAX_MULTI);
}

const frameArg = (s) => {
  const m = String(s ?? "").match(/[+-]?\d+/);
  return m ? Math.abs(Number(m[0])) : null;
};

/** Split "… as lars" off the end. */
function splitAs(args) {
  const m = String(args).match(/^(.*?)\s+(?:as|за)\s+(.+)$/i);
  return m ? { rest: m[1].trim(), as: m[2].trim() } : { rest: args, as: null };
}

const HELP = {
  fd: ["!fd <character> <move> — frame data card", "!fd Fahkumram 312 · !fd kaz df1 · !fd devil jin ws2", "!fd law dragon's tail · !fd kaz hellsweep · !fd jin ewgf", "Several at once: !fd kaz df1; jin d3 (or one per line)", "With !main set: !fd df1"],
  punish: ["!punish <character> <frames> — best punishers", "!punish kaz -13 · !punish lars 14 · with !main: !punish -14", "⭐ best reliable (community picks, combo damage) · 💪 more damage but harder · ⚠️ hard input · 🟡 just-frame", "Full list of symbols: !legend"],
  unsafe: ["!unsafe <character> [frames] — moves punishable on block", "!unsafe jin · !unsafe jin -13"],
  list: ["!list <character> <filter> — moves with a property", "!list steve lows · !list jin homing · !list kaz hopkick"],
  main: ["!main <character> — set your main (then you can skip it in commands)", "!main · !main off · !mains — who plays what here"],
  mu: ["!mu <you> vs <them> — punish sheet for the matchup", "!mu lars vs jin · with !main: !mu jin"],
  gaps: ["!gaps <character> [string] — interrupts, jails, CH-only follow-ups", "!gaps jin · !gaps jin 1,1,2"],
  ss: ["!ss <character> — which moves track which way (data is sparse)", "!ss kaz"],
  beat: ["!beat <character> <move> [as <you>] — your answers: duck/crush/power crush/sidestep/punish", "!beat kaz df+2 · !beat kaz df+2 as lars"],
  whiff: ["!whiff <character> <move> [as <you>] — whiff punish window and your options", "!whiff kaz df+2 as lars"],
  throws: ["!throws <character> — every throw with its break", "!throws king"],
  quiz: ["!quiz [character] — frame quiz (everyone answers once)", "!top · !top <character> — leaderboard"],
  heat: ["!heat <character> — engagers (with heat dash), smash, burst, heat moves", "!wall <character> — wall crush/splat, balcony, floor breaks"],
  vs: ["!vs <character> — ⏳ full guide: how to play against them", "!vs reina · !vs steve --lang ru",
    "Teaches how they play, every stance, key threats, punishes, defense, lows, mistakes and practice drills.",
    "⏳ A new guide takes 3–8 minutes (a progress message shows the steps). A guide someone already requested is instant.",
    "Buttons switch the same message between sections; 📖 Full guide opens the whole guide as a page (Instant View).",
    "Up to 5 new guides per day for each member; cached guides are unlimited.",
    "!coachlang en|ru — your guide language · !coachlevel high|mid — your level (high is the default)",
    "With !main set, the guide offers a button for your matchup."],
  coach: ["!coach <you> vs <them> — ⏳ full matchup guide for your character", "!coach kazuya vs reina · !coach lee vs steve --level mid",
    "Your plan, your best tools, what to stop doing, their threats, punishes with your moves, defense and drills.",
    "⏳ A new guide takes 3–8 minutes; a guide someone already requested is instant.",
    "Per-request options: --lang en|ru --level high|mid · see !help vs for buttons and limits"],
  tip: ["!tip vs reina #defense: your advice — submit a clan tip for admin approval", "!tip kazuya vs reina: matchup advice (20–400 characters)", "!tips vs reina · !mytips — approved tips and your submissions"],
};
HELP.coachlang = HELP.vs;
HELP.coachlevel = HELP.vs;
HELP.tips = HELP.tip;
HELP.mytips = HELP.tip;
HELP.top = HELP.quiz;
HELP.wall = HELP.heat;
HELP.mains = HELP.main;

/** /start: how clan members use the bot and help improve it (Russian, private chat). */
export const START_HTML = [
  `🤖 ${b("Бот с фреймдатой Tekken 8 и тренер по матчапам")}`,
  "Пишите боту в личку. Команды начинаются с «!». Русская раскладка работает (!ав = !fd), персонажей можно писать по-русски и прозвищами: казуя, рейна, фенг, кинг.",
  "<i>Сообщения боту видит админ — так я замечаю ошибки и непонятые запросы.</i>",
  "",
  `📋 ${b("Фреймдата — отвечает сразу")}`,
  `${code("!fd казуя df1")} — карточка приёма: стартап, блок, хит, урон`,
  `${code("!punish рейна -13")} — чем наказывать на −13`,
  `${code("!unsafe джин")} — что у персонажа наказуемо на блоке`,
  `${code("!mu ларс vs джин")} — чем ваш персонаж наказывает его приёмы`,
  `${code("!beat казуя df+2 as ларс")} — как отвечать на конкретный приём`,
  `${code("!main рейна")} — запомнить вашего мейна, тогда персонажа можно не писать: ${code("!punish -13")}`,
  details([
    `${code("!list стив low")} — приёмы по свойству (low, homing, launcher, pc, heat…)`,
    `${code("!gaps джин")} · ${code("!ss казуя")} · ${code("!whiff казуя df+2 as ларс")} — дыры в строках, сайдстеп, наказание промахов`,
    `${code("!throws кинг")} · ${code("!heat рейна")} · ${code("!wall рейна")} — броски, Heat, стена`,
    `${code("!quiz")} — викторина по фреймдате · ${code("!legend")} — что значат значки`,
    "Несколько запросов в одном сообщении — через «;» или с новой строки.",
  ].join("\n")),
  "",
  `🎓 ${b("Тренер — ⏳ 3–8 минут")}`,
  `${code("!vs рейна")} — гайд «как играть против персонажа»: как он играет, стойки, опасные приёмы, наказания, защита, ошибки, тренировки`,
  `${code("!coach казуя vs рейна")} — гайд по матчапу за вашего персонажа`,
  details([
    "Пока гайд пишется, бот показывает прогресс. Если такой гайд уже кто-то запрашивал, он придёт сразу.",
    "Кнопки под гайдом переключают разделы в том же сообщении. «📖 Полный гайд» открывает весь гайд одной страницей.",
    `${code("!coachlang ru")} — гайды на русском (по умолчанию английский) · ${code("!coachlevel mid")} — попроще (по умолчанию high)`,
    "Лимит — 5 новых гайдов в день на человека, готовые гайды без ограничений.",
    "Пункты «⚠️ Общие знания (не проверено)» — догадки модели, проверяйте их в практике.",
  ].join("\n")),
  "",
  `🛠 ${b("Как сделать бота лучше")}`,
  "• Оценивайте гайды кнопками 👍 / 👎 / ⚠️ — плохие и ошибочные гайды я перепроверю и перегенерирую.",
  `• Делитесь опытом: ${code("!tip vs рейна: ваш совет")} — совет против персонажа, ${code("!tip казуя vs рейна #defense: ваш совет")} — совет для матчапа (20–400 символов). После одобрения админом совет попадает в гайды.`,
  details([
    "Темы советов: #defense #punish #neutral #pressure #wall #heat #oki (необязательно).",
    `${code("!tips vs рейна")} — одобренные советы, голосуйте 👍 за полезные · ${code("!mytips")} — ваши советы и их статус`,
    "Бот не понял приём? Он предложит варианты — нажмите правильный. Если вариантов нет, напишите мне, и я научу бота этому названию.",
  ].join("\n")),
  "",
  `<i>Все команды с примерами: ${code("!help")} · ${code("!help vs")}</i>`,
].join("\n");

export const HELP_HTML = [
  `🤖 ${b("Tekken 8 frame data")}`,
  ...["fd", "punish", "unsafe", "list", "mu", "gaps", "beat", "ss", "whiff", "throws", "heat", "quiz", "main"].map((k) => `${code(HELP[k][0].split(" — ")[0])} — ${esc(HELP[k][0].split(" — ")[1] ?? "")}`),
  "",
  `🎓 ${b("Coach")}`,
  ...["vs", "coach", "tip"].map((k) => `${code(HELP[k][0].split(" — ")[0])} — ${esc(HELP[k][0].split(" — ")[1] ?? "")}`),
  "",
  `⏳ ${b("Takes time:")} ${code("!vs")} and ${code("!coach")} write a new guide in 3–8 minutes (you'll see progress; a guide someone already asked for is instant). Everything else answers in a second.`,
  `${code("!help <command>")} — examples, e.g. ${code("!help vs")} · ${code("!legend")} — what the emojis mean`,
  "<i>Nicknames (fahk, kaz, казуя), move names, hopkick/hellsweep/ewgf and Russian layout all work. Data: wavu.wiki</i>",
].join("\n");

export function helpFor(topic, filters) {
  const t = String(topic ?? "").toLowerCase().replace(/^!/, "").trim();
  const page = HELP[t];
  if (!page) return null;
  const extra = t === "list" ? [`<i>${esc(filters)}</i>`] : [];
  return [`${b(page[0])}`, ...page.slice(1).map((l) => esc(l)), ...extra].join("\n");
}

/**
 * @param {{index, aliases, moveAliases, mains, quiz, ruNames: Set<string>}} deps
 */
export function createBot({ index, aliases, moveAliases, mains, ruNames = new Set() }) {
  const characters = () => index.characters().map((c) => c.name);
  const reply = (html, extra = {}) => ({ kind: "reply", html, ...extra });

  /** Card reply with navigation buttons (A2). */
  function cardReply(move, { buttons = true } = {}) {
    const html = cardHtml({ character: move.character, key: move.key, chain: index.chain(move.id), combo: index.comboFor(move.id) });
    if (!buttons) return reply(html, { stat: ["card", { character: move.character, moveId: move.id }] });
    const row = [];
    if (move.parent) {
      const parent = index.move(move.parent);
      if (parent) row.push({ text: `◀ ${prettyKey(parent.character, parent.key)}`.slice(0, 28), action: { type: "card", moveId: parent.id } });
    }
    const kids = index.children(move.id);
    if (kids.length === 1) row.push({ text: `${kids[0].key} ▶`.slice(0, 28), action: { type: "card", moveId: kids[0].id } });
    else if (kids.length > 1) row.push({ text: `Strings (${kids.length}) ▶`, action: { type: "strings", moveId: move.id } });
    if (move.block_n !== null && move.block_n <= -10) row.push({ text: "🥊 Punish", action: { type: "punishMove", moveId: move.id } });
    return reply(html, { buttons: row.length ? [row] : [], askerOnly: true, stat: ["card", { character: move.character, moveId: move.id }] });
  }

  /** !fd lookup with main fallback; returns a reply or a special kind for index.js. */
  function fdLookup(args, main, { single }) {
    let a = analyze(index, `!fd ${args}`, aliases.all());
    if (a?.kind === "match") return single ? cardReply(a.move) : cardReply(a.move, { buttons: false });
    if (a?.kind === "unresolved") {
      const res = resolveMove(index, a.character, a.move, moveAliases);
      if (res.status === "match") return single ? cardReply(res.move) : cardReply(res.move, { buttons: false });
      a = { ...a, candidates: res.candidates.length ? res.candidates : a.candidates };
    }
    if (a?.kind === "unknown_character" && main) {
      const res = resolveMove(index, main, args, moveAliases);
      if (res.status === "match") return single ? cardReply(res.move) : cardReply(res.move, { buttons: false });
      const firstIsWord = /^[a-zа-яё][a-zа-яё'-]{2,}$/i.test(a.token) && args.split(" ").length > 1;
      if (!firstIsWord) return { kind: "unresolved", analysis: { kind: "unresolved", character: main, move: args, candidates: res.candidates }, viaMain: true };
    }
    if (!a) return reply(esc(HELP.fd.join("\n")));
    if (a.kind === "usage") return reply(HELP_HTML);
    if (a.kind === "need_move") return reply(`Which ${b(a.character)} move? e.g. ${code(`!fd ${a.character} df+1`)}`);
    if (a.kind === "unknown_character") return { kind: "unknown", unknown: { token: a.token, args: a.args, candidates: a.candidates } };
    return { kind: "unresolved", analysis: a };
  }

  /** Character + rest, with the sender's main as fallback (explicit character always wins). */
  function who(args, main) {
    const r = parseCharacterArgs(args, characters(), aliases.all());
    if (r.character) return r;
    if (main && !r.empty) return { character: main, rest: args, viaMain: true };
    if (main && r.empty) return { character: main, rest: "", viaMain: true };
    return r;
  }

  const needMain = (cmd) => reply(`Tell me which character you play: ${code("!main <character>")} — or add ${code("as <character>")}, e.g. ${code(`!${cmd} kaz df+2 as lars`)}`);

  function moveOf(character, text) {
    const res = resolveMove(index, character, text, moveAliases);
    return res.status === "match" ? res.move : null;
  }

  /** One command → reply. */
  /** Full answer for a list command; long ones are paged, never cut. */
  function viewHtml(v) {
    switch (v.cmd) {
      case "mu": return formatMatchup(index, v.a, v.b);
      case "unsafe": return formatUnsafe(index, v.c, v.threshold);
      case "list": return formatList(index, v.c, v.tag);
      case "gaps": return formatCharacterGaps(index, v.c);
      case "ss": return formatSidestep(index, v.c);
      case "throws": return formatThrows(index, v.c);
      case "heat": return formatHeat(index, v.c);
      case "wall": return formatWall(index, v.c);
      default: return "";
    }
  }
  /** One page of a list answer with ◀ ▶ buttons that edit the same message. */
  function paged(view, page = 0, { stat } = {}) {
    const html = viewHtml(view);
    const pages = splitHtml(html, PAGE_LIMIT);
    const n = Math.min(Math.max(0, page), pages.length - 1);
    const title = html.split("\n")[0];
    const body = n && isWellFormed(title) ? `${title} <i>(${n + 1}/${pages.length})</i>\n${pages[n]}` : pages[n];
    const nav = [];
    if (n > 0) nav.push({ text: `◀ ${n}/${pages.length}`, action: { type: "page", view, page: n - 1 } });
    if (n < pages.length - 1) nav.push({ text: `${n + 2}/${pages.length} ▶`, action: { type: "page", view, page: n + 1 } });
    const extra = view.cmd === "throws" ? [[{ text: "🎯 Throw-break quiz", action: { type: "quizStart", character: view.c, qtype: "break" } }]] : [];
    return reply(body, { ...(stat ? { stat } : {}), buttons: [...(nav.length ? [nav] : []), ...extra] });
  }

  function run({ cmd, args }, ctx, single) {
    const main = ctx.senderId ? mains.get(ctx.senderId) : null;
    switch (cmd) {
      case "vs":
      case "coach":
      case "tips": {
        const target = parseCoachTarget(args, characters(), aliases.all());
        return target.error ? reply(esc(target.error)) : { kind: cmd === "tips" ? "tips" : "coach", target };
      }
      case "tip": {
        const tip = parseTip(args, characters(), aliases.all());
        return tip.error ? reply(esc(tip.error)) : { kind: "tip", tip };
      }
      case "mytips": return { kind: "mytips" };
      case "coachlang":
      case "coachlevel": return { kind: "coachPreference", preference: cmd === "coachlang" ? { language: args.toLowerCase() } : { level: args.toLowerCase() } };
      case "fd":
        return fdLookup(args, main, { single });
      case "legend":
        return reply(LEGEND_HTML, { stat: ["help", {}] });
      case "help":
        return reply(args ? helpFor(args, filterHelp().replace(/^Filters: /, "")) ?? HELP_HTML : HELP_HTML, { stat: ["help", {}] });
      case "main": {
        if (!args) return reply(main ? `Your main: ${b(main)}` : `No main set. ${code("!main <character>")}`);
        if (/^(off|none|clear|reset)$/i.test(args)) {
          mains.clear(ctx.senderId);
          return reply("Main cleared.");
        }
        const r = resolveCharacter(args, characters(), aliases.all());
        if (!r.match) return { kind: "unknown", unknown: { token: args.split(" ")[0], args, candidates: r.candidates } };
        mains.set(ctx.senderId, r.match, { chatId: ctx.chatId, name: ctx.senderName });
        return reply(`✅ Your main: ${b(r.match)}. Now ${code("!punish -14")}, ${code("!fd df1")}, ${code("!mu jin")} use it.`, { stat: ["main", { character: r.match }] });
      }
      case "mains": {
        const roster = mains.roster(ctx.chatId);
        if (!roster.length) return reply(`Nobody here has set a main yet. ${code("!main <character>")}`);
        const by = {};
        for (const r of roster) (by[r.character] ??= []).push(esc(r.name));
        return reply([`👥 ${b("Mains in this chat")}`, ...Object.entries(by).map(([c, names]) => `${b(c)}: ${names.join(", ")}`)].join("\n"));
      }
      case "quiz": {
        const character = args ? resolveCharacter(args, characters(), aliases.all()).match : null;
        if (args && !character) return { kind: "unknown", unknown: { token: args.split(" ")[0], args, candidates: resolveCharacter(args, characters(), aliases.all()).candidates } };
        const q = makeQuestion(index, { character });
        return q ? { kind: "quiz", question: q } : reply("No quiz question available.");
      }
      case "top": {
        const character = args ? resolveCharacter(args, characters(), aliases.all()).match : null;
        return { kind: "top", character };
      }
      case "mu": {
        const vs = args.split(/\s+vs\.?\s+|\s+против\s+/i);
        let a;
        let bTxt;
        if (vs.length === 2) [a, bTxt] = vs;
        else {
          const r = parseCharacterArgs(args, characters(), aliases.all());
          if (r.character && r.rest) {
            a = r.character;
            bTxt = r.rest;
          } else {
            a = main;
            bTxt = args;
          }
        }
        if (!a) return needMain("mu");
        const A = resolveCharacter(a, characters(), aliases.all()).match;
        const B = resolveCharacter(bTxt, characters(), aliases.all()).match;
        if (!A || !B) return { kind: "unknown", unknown: { token: (!A ? a : bTxt).split(" ")[0], args, candidates: resolveCharacter(!A ? a : bTxt, characters(), aliases.all()).candidates } };
        return paged({ cmd: "mu", a: A, b: B }, 0, { stat: ["mu", { character: B }] });
      }
      case "beat":
      case "whiff": {
        const { rest, as } = splitAs(args);
        const target = parseCharacterArgs(rest, characters(), aliases.all());
        if (target.unknown) return { kind: "unknown", unknown: { token: target.unknown, args, candidates: target.candidates } };
        if (!target.character || !target.rest) return reply(esc(HELP[cmd].join("\n")));
        const A = as ? resolveCharacter(as, characters(), aliases.all()).match : main;
        if (!A) return needMain(cmd);
        const move = moveOf(target.character, target.rest);
        if (!move) return reply(`❌ ${b(target.character)} ${code(target.rest)} not found — try ${code(`!fd ${target.character} ${target.rest}`)}`);
        return reply(cmd === "beat" ? formatBeat(index, A, move) : formatWhiff(index, A, move), { stat: [cmd, { character: target.character, moveId: move.id }] });
      }
      default:
        break;
    }
    // single-character commands with main fallback
    const r = who(args, main);
    if (r.unknown) return { kind: "unknown", unknown: { token: r.unknown, args, candidates: r.candidates } };
    if (r.empty) return reply(esc((HELP[cmd] ?? HELP.fd).join("\n")));
    const c = r.character;
    const stat = [cmd, { character: c }];
    switch (cmd) {
      case "punish": {
        const f = frameArg(r.rest);
        return f ? reply(formatPunish(index, c, Math.min(f, 30)), { stat }) : reply(esc(HELP.punish.join("\n")));
      }
      case "unsafe": {
        const f = frameArg(r.rest);
        return paged({ cmd: "unsafe", c, threshold: f ? -f : -10 }, 0, { stat });
      }
      case "list": {
        const tag = resolveFilter(r.rest);
        if (!tag) return reply(`${r.rest ? `Unknown filter “${esc(r.rest.slice(0, 30))}”. ` : ""}${esc(HELP.list.join("\n"))}\n<i>${esc(filterHelp())}</i>`);
        return paged({ cmd: "list", c, tag }, 0, { stat });
      }
      case "gaps": {
        if (!r.rest) return paged({ cmd: "gaps", c }, 0, { stat });
        const move = moveOf(c, r.rest);
        return move ? reply(formatString(index, c, move), { stat }) : reply(`❌ ${b(c)} ${code(r.rest)} not found`);
      }
      case "ss":
        return paged({ cmd: "ss", c }, 0, { stat });
      case "throws":
        return paged({ cmd: "throws", c }, 0, { stat });
      case "heat":
        return paged({ cmd: "heat", c }, 0, { stat });
      case "wall":
        return paged({ cmd: "wall", c }, 0, { stat });
      default:
        return reply(HELP_HTML);
    }
  }

  return {
    /** @returns {null | {kind, html?, buttons?, …}[]} null = not a bot command */
    handle(text, ctx) {
      const fixed = fixLayout(text, COMMANDS, ruNames);
      const cmds = parseCommands(fixed);
      if (!cmds.length) return null;
      if (ctx.senderId && ctx.chatId) mains.seen(ctx.senderId, ctx.chatId, ctx.senderName);
      const single = cmds.length === 1;
      return cmds.map((c) => ({ cmd: c.cmd, args: c.args, ...run(c, ctx, single) }));
    },

    /** Button action → {edit?: reply, reply?: reply, special?} */
    action(a, ctx) {
      const main = ctx.senderId ? mains.get(ctx.senderId) : null;
      switch (a.type) {
        case "card": {
          const m = index.move(a.moveId);
          return m ? { edit: cardReply(m) } : {};
        }
        case "page":
          return a.view ? { edit: paged(a.view, a.page) } : {};
        case "strings": {
          const m = index.move(a.moveId);
          if (!m) return {};
          const card = cardReply(m);
          const kids = index.children(m.id).slice(0, 9).map((k) => ({ text: prettyKey(k.character, k.key).slice(0, 24), action: { type: "card", moveId: k.id } }));
          const rows = [];
          for (let i = 0; i < kids.length; i += 3) rows.push(kids.slice(i, i + 3));
          return { edit: { ...card, buttons: [...rows, ...(card.buttons ?? []).map((row) => row.filter((x) => x.action.type !== "strings"))].filter((r) => r.length) } };
        }
        case "punishMove":
        case "punishAs": {
          const m = index.move(a.moveId);
          if (!m) return {};
          const as = a.character ?? main;
          if (!as) {
            const picks = (a.popular ?? ["Kazuya", "Jin", "Lars", "King", "Bryan", "Reina"]).slice(0, 6)
              .map((c) => ({ text: c, action: { type: "punishAs", moveId: m.id, character: c } }));
            // the card turns into the character picker; "Back" restores the card
            return { edit: reply(`Which character punishes ${b(m.character)} ${mk(m.character, m.key)} (${esc(cleanInline(m.block))})? Set ${code("!main <character>")} to skip this.`, { buttons: [picks.slice(0, 3), picks.slice(3), [{ text: "◀ Back to card", action: { type: "card", moveId: m.id } }]], askerOnly: true }) };
          }
          return { edit: reply(formatPunish(index, as, Math.abs(m.block_n)).replace(/^🥊 <b>/, `🥊 <b>vs ${esc(m.character)} ${esc(prettyKey(m.character, m.key))} · `), { stat: ["punish", { character: as }], buttons: [[{ text: "◀ Back to card", action: { type: "card", moveId: m.id } }]] }) };
        }
        default:
          return {};
      }
    },

    questionHtml,
  };
}

export { minus, splitQuery };
