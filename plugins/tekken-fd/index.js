// OpenClaw plugin: Tekken 8 frame data from Wavu Wiki for the clan Telegram group.
//
// Tools (model resolves *which* move; numbers only ever come from the index):
//   tekken_frame_data  {character, move}   deterministic lookup → posts card, or returns candidates
//   tekken_pick_move   {id} | {notFound}   posts the card for a chosen id, or a "did you mean" reply
// Owner commands: /fd_sync [dry|force], /fd_rebuild, /fd_status, /fd_check
// Service: daily Wavu change watcher → DM to the owner.
// Hook: before_dispatch fast path — "!fd <char> <move>" that resolves exactly is answered without the model.
import fs from "node:fs";
import path from "node:path";
import { MoveIndex } from "./src/db.js";
import { formatCard, formatSuggestions } from "./src/format.js";
import { resolveCharacter, resolveMove } from "./src/resolve.js";
import { AliasStore, parseAliasReply } from "./src/aliases.js";
import { isHelpCommand } from "./src/fastpath.js";
import { createBot, HELP_HTML, MENTION_PATTERN } from "./src/bot.js";
import { MoveAliasStore } from "./src/nicknames.js";
import { Mains } from "./src/mains.js";
import { makeQuestion, Quiz, questionHtml, REVEAL_AFTER_MS } from "./src/quiz.js";
import { b, code, esc, toPlain } from "./src/render.js";
import { actionData, allTokens, createToken, getToken, keyboard, NAMESPACE as BUTTON_NAMESPACE, parsePayload, postData, removeTokens, updateToken } from "./src/buttons.js";
import { formatDigest, hasFrameChanges } from "./src/digest.js";
import { Stats } from "./src/stats.js";
import { readMeta } from "./src/snapshot.js";
import { chatIdFrom, deleteMessage, editMessageText, memberName, sendMessage, sendReply, setMyCommands } from "./src/telegram.js";
import { headCommit, lastDataCommit, paths, rebuild, sync } from "./src/sync.js";
import { ProgressBoard, SYNC_STEPS } from "./src/progress.js";
import { pushAndWait, pushStatusLine } from "./src/push.js";
import { checkOnce, readState, startWatcher, writeState } from "./src/watcher.js";
import { createCoachTransport } from "./src/coach/transport.js";


const configSchema = {
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      repoDir: { type: "string" },
      stateDir: { type: "string" },
      ownerChatId: { type: "string" },
      watcher: { type: "boolean" },
      fastPathAgents: { type: "array", items: { type: "string" } },
      publicAgents: { type: "array", items: { type: "string" } },
      adminIds: { type: "array", items: { type: "string" } },
      quiz: { type: "object", properties: { dailyAt: { type: "string" }, tz: { type: "string" }, daily: { type: "boolean" } } },
      coach: { type: "object", properties: { enabled: { type: "boolean" }, access: { enum: ["admins", "clan"] }, model: { type: "string" }, models: { type: "object" }, allowlist: { type: "array", items: { type: "string" } } } },
      tips: { type: "object", properties: { openSubmissions: { type: "boolean" } } },
    },
  },
  safeParse(value) {
    if (value === undefined) return { success: true, data: undefined };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { success: false, error: { issues: [{ path: [], message: "expected config object" }] } };
    }
    return { success: true, data: value };
  },
};

const text = (t, details) => ({ content: [{ type: "text", text: t }], details: details ?? {} });

function ownerChatIdFrom(api) {
  if (api.pluginConfig?.ownerChatId) return String(api.pluginConfig.ownerChatId);
  const owners = api.config?.commands?.ownerAllowFrom ?? [];
  const tg = owners.map(String).find((o) => o.startsWith("telegram:"));
  return tg ? tg.slice("telegram:".length) : null;
}

export default {
  id: "tekken-fd",
  name: "Tekken Frame Data",
  description: "Tekken 8 frame data lookups (Wavu Wiki) for Telegram groups.",
  get configSchema() {
    return configSchema;
  },
  register(api) {
    const repoDir = api.pluginConfig?.repoDir ?? "/opt/clan-bots";
    const stateDir = api.pluginConfig?.stateDir
      ?? path.join(process.env.OPENCLAW_STATE_DIR ?? path.join(process.env.HOME ?? "/home/node", ".openclaw"), "tekken-fd");
    fs.mkdirSync(stateDir, { recursive: true });
    const p = paths(repoDir, stateDir);
    const index = new MoveIndex(p.dbPath);
    let busy = null; // serialises sync/rebuild
    // The watcher reports edits made after the data we have: anchor it to the last sync.
    if (!readState(p.statePath).lastWatchCheck) {
      const syncedAt = readMeta(p.dataDir)?.syncedAt;
      if (syncedAt) writeState(p.statePath, { lastWatchCheck: syncedAt, pendingCharacters: [] });
    }

    const ensureIndex = () => {
      if (!fs.existsSync(p.dbPath) && fs.existsSync(p.dataDir)) rebuild(p);
    };
    const characterNames = () => {
      ensureIndex();
      return index.characters().map((c) => c.name);
    };

    const cardFor = (move) => formatCard({ character: move.character, key: move.key, chain: index.chain(move.id) }); // model path (plain)
    const aliases = new AliasStore({
      curatedPath: api.resolvePath ? api.resolvePath("aliases.json") : path.join(repoDir, "plugins/tekken-fd/aliases.json"),
      addedPath: path.join(repoDir, "data", "aliases.json"),
      repoDir,
    });
    const moveAliases = new MoveAliasStore({ file: path.join(repoDir, "data", "move-aliases.json"), repoDir });
    const mains = new Mains(path.join(stateDir, "mains.json"));
    const quiz = new Quiz(path.join(stateDir, "quiz.json"));
    const ruNames = (() => {
      try {
        return new Set(Object.keys(JSON.parse(fs.readFileSync(api.resolvePath ? api.resolvePath("aliases.ru.json") : path.join(repoDir, "plugins/tekken-fd/aliases.ru.json"), "utf8"))));
      } catch {
        return new Set();
      }
    })();
    const bot = createBot({ index, aliases, moveAliases, mains, ruNames });
    const digits = (v) => (String(v ?? "").match(/-?\d{5,}/) ?? [null])[0];
    const admins = () => new Set([ownerChatIdFrom(api), ...(api.pluginConfig?.adminIds ?? [])].filter(Boolean).map(String));
    // Agents whose sessions may hand vague !fd queries to the model; elsewhere the plugin answers itself.
    const reasoningAgents = api.pluginConfig?.fastPathAgents ?? ["fd"];
    const PUBLIC_AGENTS = api.pluginConfig?.publicAgents ?? ["fd"]; // DMs here only get bot commands and help
    const stats = new Stats(path.join(stateDir, "stats.json"));
    const clanGroups = () => Object.keys(api.config?.channels?.telegram?.groups ?? {}).filter((id) => /^-\d+$/.test(id));
    const quizCfg = { dailyAt: api.pluginConfig?.quiz?.dailyAt ?? "19:00", tz: api.pluginConfig?.quiz?.tz ?? "Europe/Moscow", daily: api.pluginConfig?.quiz?.daily !== false };
    const HTML = { parseMode: "HTML" };

    // ---- transport: HTML message with action buttons (callback_data "tekken-fd:a:<token>:<i>")
    function markupFor(token, buttons) {
      let i = 0;
      return keyboard([], 3, buttons.map((row) => row.map((btn) => ({ text: btn.text, callback_data: actionData(token, i++) }))));
    }
    // Telegram caps messages at 4096 visible characters; long replies degrade to truncated plain text
    const MAX_VISIBLE = 4000;
    function fit(html) {
      const plain = toPlain(html);
      if (plain.length <= MAX_VISIBLE) return { text: html, extra: HTML };
      return { text: `${plain.slice(0, MAX_VISIBLE - 40)}\n… (truncated)`, extra: {} };
    }
    async function sendHtml(chatId, replyTo, html, { buttons = [], askerId = null, askerOnly = true, meta = {} } = {}) {
      const actions = buttons.flat().map((btn) => btn.action);
      const token = actions.length ? createToken(p.statePath, { kind: "actions", chatId: String(chatId), askerId, askerOnly, actions, originalMessageId: replyTo, ...meta }) : null;
      const f = fit(html);
      const extra = { ...f.extra, ...(token ? { replyMarkup: markupFor(token, buttons) } : {}) };
      const sent = replyTo ? await sendReply(chatId, replyTo, f.text, undefined, extra) : await sendMessage(chatId, f.text, undefined, extra);
      if (token) updateToken(p.statePath, token, { messageId: sent?.message_id ?? null });
      return { messageId: sent?.message_id ?? null, token };
    }
    /** Threaded reply for a dispatch event; falls back to a plain gateway reply off Telegram. */
    async function answer(event, ctx, html, opts = {}) {
      const channel = String(ctx?.channelId ?? event?.channel ?? "");
      const chatId = chatIdFrom(ctx?.conversationId);
      const messageId = event?.messageId ?? ctx?.messageId;
      if (channel === "telegram" && chatId && /^\d+$/.test(String(messageId ?? ""))) {
        try {
          const r = await sendHtml(chatId, messageId, html, { askerId: String(digits(event?.senderId) ?? ""), ...opts });
          return { handled: true, sentId: r.messageId, chatId };
        } catch (err) {
          api.logger?.warn?.(`tekken-fd reply failed (${err.message}); sending plain`);
        }
      }
      return { handled: true, text: toPlain(html) };
    }
    const done = (r) => (r.text ? { handled: true, text: r.text } : { handled: true });
    // Created once; model calls remain command-triggered and access-checked.
    const coachTransport = createCoachTransport({ api, index, repoDir, stateDir, p, admins, clanGroups, mains, sendHtml, answer, done,
      ownerOnly: (handler) => ownerOnly(handler), exclusive: (label, fn) => exclusive(label, fn) });

    // ---- "did you mean" (buttons, asker only) — removed when the asker gets a card (#6)
    async function cleanupSuggestions(chatId, askerId) {
      const cutoff = Date.now() - 15 * 60 * 1000;
      const old = removeTokens(p.statePath, (t) => t.suggest && t.chatId === chatId && t.askerId === askerId && Date.parse(t.at) >= cutoff);
      for (const t of old) if (t.messageId) await deleteMessage(t.chatId, t.messageId).catch(() => {});
    }
    async function sendSuggestions(event, ctx, a) {
      const chatId = chatIdFrom(ctx?.conversationId);
      const askerId = String(digits(event?.senderId) ?? "");
      const choices = (a.candidates ?? []).slice(0, 6);
      const head = `❌ Not found: ${b(a.character)} ${code(a.move.slice(0, 60))}`;
      if (!choices.length) return done(await answer(event, ctx, head));
      if (chatId) await cleanupSuggestions(chatId, askerId);
      const buttons = [];
      for (let i = 0; i < choices.length; i += 3) buttons.push(choices.slice(i, i + 3).map((m) => ({ text: m.key.slice(0, 24), action: { type: "pick", moveId: m.id } })));
      const html = `${head}\nDid you mean: ${choices.map((m) => code(m.key)).join(" · ")}\n<i>tap the right one${admins().size ? " · admin: reply with the input to teach this name" : ""}</i>`;
      return done(await answer(event, ctx, html, { buttons, meta: { suggest: { character: a.character, query: a.move } } }));
    }
    async function sendCardReply(event, ctx, r) {
      const res = await answer(event, ctx, r.html, { buttons: r.buttons ?? [] });
      const chatId = chatIdFrom(ctx?.conversationId);
      if (chatId) await cleanupSuggestions(chatId, String(digits(event?.senderId) ?? ""));
      return done(res);
    }

    // ---- quiz (B6)
    async function postQuiz(chatId, replyTo, q) {
      if (!q) return null;
      const id = quiz.create(chatId, q);
      const buttons = [q.options.slice(0, 2), q.options.slice(2, 4)].map((row, r) => row.map((opt, c) => ({ text: opt, action: { type: "quiz", qid: id, i: r * 2 + c } })));
      const sent = await sendHtml(chatId, replyTo, questionHtml(q), { buttons, askerOnly: false });
      quiz.setMessage(id, sent.messageId);
      setTimeout(() => revealQuiz(id).catch(() => {}), REVEAL_AFTER_MS).unref?.();
      stats.record("quiz", { character: q.character });
      return id;
    }
    async function revealQuiz(id) {
      const q = quiz.get(id);
      const html = quiz.reveal(id);
      if (!html || !q?.messageId) return;
      await editMessageText(q.chatId, q.messageId, html, undefined, HTML).catch((err) => api.logger?.warn?.(`tekken-fd quiz reveal failed: ${err.message}`));
      removeTokens(p.statePath, (t) => t.actions?.some?.((a) => a.type === "quiz" && a.qid === id));
    }

    // ---- unknown character → alias request (groups/admin DM: in place; other DMs: to the admins)
    const pendingAliases = () => (readState(p.statePath).pendingAliases ?? []).filter((x) => Date.now() - Date.parse(x.at) < 14 * 864e5);
    const savePending = (list) => writeState(p.statePath, { pendingAliases: list.slice(-100) });
    async function askAlias(event, ctx, cmd, args, unknown, isDirect, isAdmin) {
      const chatId = chatIdFrom(ctx?.conversationId);
      const token = unknown.token.slice(0, 30);
      const base = { originalMessageId: event?.messageId ?? null, alias: token.toLowerCase(), cmd, args, at: new Date().toISOString() };
      stats.record("unknown", { unknown: token });
      const closest = unknown.candidates?.length ? `\nClosest: ${unknown.candidates.map((c) => b(c)).join(" · ")}` : "";
      if (!isDirect || isAdmin) {
        const r = await answer(event, ctx, `❓ Unknown character: ${code(token)}${closest}\n<i>Admin: reply to this message with the character name to add “${esc(token.toLowerCase())}” as an alias.</i>`);
        if (r.sentId && r.chatId) savePending([...pendingAliases(), { ...base, chatId: r.chatId, messageId: r.sentId, askChatId: r.chatId }]);
        return done(r);
      }
      const r = await answer(event, ctx, `❓ Unknown character: ${code(token)}. I've asked an admin to add it — you'll get the answer here.`);
      const who = digits(event?.senderId) ?? "?";
      for (const admin of admins()) {
        try {
          const sent = await sendHtml(admin, null, `❓ Unknown character ${code(token)} from user ${esc(who)}: ${code(`!${cmd} ${String(args).slice(0, 80)}`)}${closest}\nReply to this message with the character name to add “${esc(token.toLowerCase())}” as an alias.`);
          if (sent.messageId) savePending([...pendingAliases(), { ...base, chatId: String(admin), messageId: sent.messageId, askChatId: r.chatId ?? chatId }]);
        } catch (err) {
          api.logger?.warn?.(`tekken-fd: alias request to admin ${admin} failed: ${err.message}`);
        }
      }
      return done(r);
    }

    async function handleAliasReply(event, ctx, pending) {
      const characters = characterNames();
      const parsed = parseAliasReply(event.content ?? event.body, pending.alias, aliases, characters);
      if (parsed.error) {
        const closest = resolveCharacter(pending.alias, characters, aliases.all()).candidates;
        const example = closest[0] ?? characters[0];
        const r = await answer(event, ctx, `❌ ${esc(parsed.error)}.${closest.length ? ` Closest: ${closest.map((c) => b(c)).join(" · ")}.` : ""}\nReply to this message with an exact name, e.g. ${code(example)} or ${code(`${pending.alias} = ${example}`)}.`);
        if (r.sentId && r.chatId) savePending([...pendingAliases(), { ...pending, chatId: r.chatId, messageId: r.sentId }]);
        return done(r);
      }
      const added = await aliases.add(parsed.alias, parsed.character, characters);
      savePending(pendingAliases().filter((x) => !(x.at === pending.at && x.args === pending.args)));
      api.logger?.info?.(`tekken-fd alias added: ${added.alias} → ${added.character} (${added.commit})`);
      await answer(event, ctx, `✅ Alias added: ${code(added.alias)} → ${b(added.character)}${added.previous && added.previous !== added.character ? ` (was ${esc(added.previous)})` : ""}`);
      // answer the original question now that the character is known
      if (pending.originalMessageId) {
        const replies = bot.handle(`!${pending.cmd ?? "fd"} ${pending.args}`, { senderId: null, chatId: pending.askChatId ?? pending.chatId });
        const first = replies?.[0];
        if (first?.kind === "reply") await sendHtml(pending.askChatId ?? pending.chatId, pending.originalMessageId, first.html).catch(() => {});
      }
      return { handled: true };
    }

    /** Admin replies to a "did you mean" with the right input → move alias for that character. */
    async function handleMoveAliasReply(event, ctx, t) {
      const input = String(event.content ?? event.body ?? "").trim();
      const res = resolveMove(index, t.suggest.character, input, moveAliases);
      if (res.status !== "match") return done(await answer(event, ctx, `❌ ${b(t.suggest.character)} ${code(input.slice(0, 40))} isn't an exact move — reply with the input, e.g. ${code("df+2")}.`));
      const added = await moveAliases.add(t.suggest.character, t.suggest.query, res.move.key);
      removeTokens(p.statePath, (x) => x.token === t.token);
      if (t.messageId) await deleteMessage(t.chatId, t.messageId).catch(() => {});
      await answer(event, ctx, `✅ Move alias added: ${b(added.character)} ${code(added.alias)} → ${code(added.key)}`);
      if (t.originalMessageId) {
        const card = bot.handle(`!fd ${t.suggest.character} ${res.move.key}`, { senderId: null, chatId: t.chatId })?.[0];
        if (card?.kind === "reply") await sendHtml(t.chatId, t.originalMessageId, card.html, { buttons: card.buttons, askerId: t.askerId }).catch(() => {});
      }
      return { handled: true };
    }

    /** Several lookups in one message → one combined reply (no buttons). */
    function combined(replies) {
      return replies.map((r) => {
        if (r.kind === "reply") return r.html;
        if (r.kind === "unknown") return `❓ Unknown character: ${code(r.unknown.token)}`;
        if (r.kind === "unresolved") return `❌ Not found: ${b(r.analysis.character)} ${code(r.analysis.move)}${r.analysis.candidates?.length ? ` — did you mean ${r.analysis.candidates.slice(0, 4).map((m) => code(m.key)).join(" · ")}` : ""}`;
        if (r.kind === "quiz") return "🎯 quiz: send !quiz on its own";
        if (r.kind === "top") return quiz.leaderboard("_", {});
        return "";
      }).filter(Boolean).join("\n\n");
    }

    api.on("before_dispatch", async (event, ctx) => {
      const sessionKey = String(event?.sessionKey ?? "");
      const body = event?.content ?? event?.body;
      const isPublic = PUBLIC_AGENTS.some((id) => sessionKey.startsWith(`agent:${id}:`));
      const isDirect = event?.isGroup === false;
      const senderId = String(digits(event?.senderId) ?? "");
      const isAdmin = admins().has(senderId);
      const chatId = chatIdFrom(ctx?.conversationId);
      const started = Date.now();
      try {
        // 1) admin replies: unknown-character requests and "did you mean" (move aliases)
        const replyTo = String(event?.replyToId ?? "");
        if (replyTo && chatId) {
          if (await coachTransport.handleAdminReply(event, ctx, senderId, replyTo)) return { handled: true };
          const pending = pendingAliases().find((x) => x.chatId === chatId && String(x.messageId) === replyTo);
          if (pending) return isAdmin ? await handleAliasReply(event, ctx, pending) : { handled: true };
          const sug = allTokens(p.statePath).find((t) => t.suggest && t.chatId === chatId && String(t.messageId) === replyTo);
          if (sug && isAdmin && !/^\s*!/.test(String(body))) return await handleMoveAliasReply(event, ctx, sug);
        }
        // 2) /start and /help
        if (isHelpCommand(body) && (isPublic || !isAdmin)) {
          stats.record("help");
          return done(await answer(event, ctx, HELP_HTML));
        }
        // 3) bot commands
        const isMain = /^\s*!(?:main|ьфшт)(?=\s|$)/i.test(String(body));
        const senderName = isMain && chatId && senderId ? await memberName(chatId, senderId).catch(() => null) : null;
        ensureIndex();
        const replies = bot.handle(body, { senderId, chatId, senderName, isDirect });
        if (!replies) return isPublic && isDirect ? done(await answer(event, ctx, HELP_HTML)) : undefined;
        if (replies.length > 1) {
          if (replies.some((r) => ["coach", "tip", "tips", "mytips", "coachPreference"].includes(r.kind))) return done(await answer(event, ctx, "Send coach and tip commands on their own."));
          stats.record("multi");
          return done(await answer(event, ctx, combined(replies)));
        }
        const r = replies[0];
        if (r.stat) stats.record(...r.stat);
        switch (r.kind) {
          case "coach":
          case "coachPreference":
          case "tip":
          case "tips":
          case "mytips":
            try { return await coachTransport.handle(r, event, ctx, senderId); }
            catch (err) { return done(await answer(event, ctx, `❌ ${esc(err.message)}`)); }
          case "reply":
            if (r.stat?.[0] === "card") {
              api.logger?.info?.(`tekken-fd fast path: ${r.stat[1].moveId} in ${Date.now() - started}ms (${sessionKey})`);
              return await sendCardReply(event, ctx, r);
            }
            return done(await answer(event, ctx, r.html, { buttons: r.buttons ?? [], askerOnly: r.askerOnly !== false }));
          case "unknown":
            return await askAlias(event, ctx, r.cmd, r.args, r.unknown, isDirect, isAdmin);
          case "unresolved":
            if (r.analysis.candidates?.length) {
              stats.record("suggest", { character: r.analysis.character });
              return await sendSuggestions(event, ctx, r.analysis);
            }
            if (!r.viaMain && reasoningAgents.some((id) => sessionKey.startsWith(`agent:${id}:`))) {
              stats.record("model", { character: r.analysis.character });
              return undefined; // nothing close: the fd model reasons about a descriptive query
            }
            return done(await answer(event, ctx, `❌ Not found: ${b(r.analysis.character)} ${code(r.analysis.move)}`));
          case "quiz":
            if (!chatId) return done(await answer(event, ctx, "Quiz works in Telegram chats."));
            await postQuiz(chatId, event?.messageId ?? null, r.question);
            return { handled: true };
          case "top":
            return done(await answer(event, ctx, quiz.leaderboard(chatId, { character: r.character })));
          default:
            return undefined;
        }
      } catch (err) {
        api.logger?.warn?.(`tekken-fd before_dispatch failed: ${err.stack ?? err.message}`);
        if (/^\s*!(?:vs|coach(?:lang|level)?|tip(?:s)?|mytips|мы|сщфср|сщфсрдфтп|сщфсрдумуд|ешз|ешзы|ьнешзы)(?=\s|$)/i.test(String(body))) return { handled: true, text: "Coach data is unavailable. Ask an admin to check /fd_status and /fd_rebuild." };
        return isPublic && isDirect ? { handled: true, text: toPlain(HELP_HTML) } : undefined;
      }
    });

    // ---- button presses (OpenClaw routes callback_data "tekken-fd:…" here)
    api.registerInteractiveHandler?.({
      channel: "telegram",
      namespace: BUTTON_NAMESPACE,
      handler: async (ictx) => {
        const { action: kind, token, index: i } = parsePayload(ictx?.callback?.payload);
        const presser = String(digits(ictx?.senderId) ?? "");
        const t = getToken(p.statePath, token);
        if (!t) {
          await Promise.resolve(ictx?.respond?.clearButtons?.()).catch(() => {}); // expired: remove stale buttons
          return { handled: true };
        }
        try {
          // legacy tokens from v1 messages
          if (kind === "s" && t.kind === "suggest") {
            if (presser !== t.askerId) return { handled: true };
            const move = index.move(t.choices[i]);
            removeTokens(p.statePath, (x) => x.token === token);
            await ictx.respond.deleteMessage().catch(() => {});
            if (move) await sendHtml(t.chatId, t.originalMessageId, bot.handle(`!fd ${move.character} ${move.key}`, {})?.[0]?.html ?? cardFor(move));
            return { handled: true };
          }
          if (kind === "post" || t.kind === "post") {
            if (!admins().has(presser)) return { handled: true };
            const groups = clanGroups();
            for (const g of groups) await sendMessage(g, t.text);
            removeTokens(p.statePath, (x) => x.token === token);
            await ictx.respond.editMessage({ text: `${t.text}\n\n✅ Posted to ${groups.length} group(s).` });
            return { handled: true };
          }
          if (t.kind !== "actions") return { handled: true };
          const action = t.actions[i];
          if (!action) return { handled: true };
          // Coach feedback/voting and admin review buttons check their own permissions.
          if (await coachTransport.action(action, t, presser)) return { handled: true };
          if (action.type === "quiz") {
            const name = ictx.senderUsername ? `@${ictx.senderUsername}` : await memberName(t.chatId, presser).catch(() => presser);
            const res = quiz.answer(action.qid, presser, name, action.i);
            if (res.status === "accepted") stats.record(res.correct ? "quizRight" : "quizWrong");
            if (res.reveal) await revealQuiz(action.qid);
            return { handled: true };
          }
          if (t.askerOnly && presser !== t.askerId) return { handled: true }; // only the person who asked
          if (action.type === "pick") {
            const move = index.move(action.moveId);
            removeTokens(p.statePath, (x) => x.token === token);
            await ictx.respond.deleteMessage().catch(() => {});
            if (!move) return { handled: true };
            const card = bot.handle(`!fd ${move.character} ${move.key}`, {})[0];
            await sendHtml(t.chatId, t.originalMessageId, card.html, { buttons: card.buttons ?? [], askerId: t.askerId });
            stats.record("button", { character: move.character, moveId: move.id });
            return { handled: true };
          }
          if (action.type === "quizStart") {
            await postQuiz(t.chatId, null, makeQuestion(index, { character: action.character, type: action.qtype }));
            return { handled: true };
          }
          const popular = Object.entries(stats.data?.total?.characters ?? {}).sort((x, y) => y[1] - x[1]).map(([c]) => c);
          const out = bot.action({ ...action, popular: popular.length >= 6 ? popular : undefined }, { senderId: presser });
          if (out.edit) {
            removeTokens(p.statePath, (x) => x.token === token);
            const newToken = out.edit.buttons?.length ? createToken(p.statePath, { kind: "actions", chatId: t.chatId, askerId: t.askerId, askerOnly: true, actions: out.edit.buttons.flat().map((x) => x.action), originalMessageId: t.originalMessageId, messageId: t.messageId }) : null;
            await editMessageText(t.chatId, t.messageId, out.edit.html, undefined, { ...HTML, ...(newToken ? { replyMarkup: markupFor(newToken, out.edit.buttons) } : {}) });
          }
          if (out.reply) await sendHtml(t.chatId, t.messageId ?? t.originalMessageId, out.reply.html, { buttons: out.reply.buttons ?? [], askerId: t.askerId });
        } catch (err) {
          api.logger?.warn?.(`tekken-fd button failed: ${err.stack ?? err.message}`);
        }
        return { handled: true };
      },
    });

    const candidateLines = (moves) => moves.map((m) => `- id=${m.id} | input=${m.key} | name=${m.name ?? "-"} | hit=${m.target ?? "-"}`).join("\n");

    async function deliver(ctx, card, details) {
      if (ctx?.delivery?.send) {
        await ctx.delivery.send({ text: card });
        return text("The frame-data card was posted to the chat. Do not repeat or summarise it. Reply with exactly: NO_REPLY", { ...details, delivered: true });
      }
      return text(`Reply with exactly this card, verbatim, and nothing else:\n\n${card}`, { ...details, delivered: false });
    }

    api.registerTool((ctx) => ({
      name: "tekken_frame_data",
      label: "Tekken frame data",
      description:
        "Look up Tekken 8 frame data (Wavu Wiki) and post the frame-data card to the chat. " +
        "Pass the character and the move exactly as the user meant them (e.g. character 'Fahkumram', move '3,1,2' or 'df+1' or a move name). " +
        "If the result lists candidates, pick the one the user most likely meant and call tekken_pick_move.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["character", "move"],
        properties: {
          character: { type: "string", description: "Character name or nickname, e.g. 'Fahkumram', 'fahk', 'Devil Jin'." },
          move: { type: "string", description: "Move input in Tekken notation or the move's name, e.g. '3,1,2', 'df+1', 'ws2', 'Ayutthaya Piercing Thunder'." },
        },
      },
      async execute(_toolCallId, params) {
        ensureIndex();
        const chars = index.characters().map((c) => c.name);
        const who = resolveCharacter(params.character, chars, aliases.all());
        if (!who.match) {
          return text(
            `Unknown character "${params.character}". ` +
            (who.candidates.length ? `Closest: ${who.candidates.join(", ")}. ` : "") +
            `All characters: ${chars.join(", ")}. If one clearly fits, call tekken_frame_data again with it; ` +
            `otherwise call tekken_pick_move with notFound.`,
            { status: "unknown_character" },
          );
        }
        const res = resolveMove(index, who.match, params.move);
        if (res.status === "match") return deliver(ctx, cardFor(res.move), { status: "match", id: res.move.id });
        if (res.status === "ambiguous") {
          return text(
            `Several ${who.match} moves could match "${params.move}":\n${candidateLines(res.candidates)}\n` +
            `Pick the one the user meant and call tekken_pick_move with its id. If none fits, call tekken_pick_move with notFound and up to 5 of these ids as suggestions.`,
            { status: "ambiguous", character: who.match },
          );
        }
        return text(
          `No ${who.match} move matches "${params.move}".` +
          (res.candidates.length ? ` Nearest:\n${candidateLines(res.candidates)}\n` : " ") +
          `If one is clearly what the user meant, call tekken_pick_move with its id; otherwise call tekken_pick_move with notFound (character "${who.match}", the query, and suggestion ids).`,
          { status: "none", character: who.match },
        );
      },
    }), { names: ["tekken_frame_data"] });

    api.registerTool((ctx) => ({
      name: "tekken_pick_move",
      label: "Tekken pick move",
      description:
        "Post the frame-data card for an exact Wavu move id returned by tekken_frame_data, " +
        "or post a 'not found / did you mean' reply when nothing matches.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Exact move id from the candidate list, e.g. 'Fahkumram-3,1,2'." },
          notFound: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: {
              character: { type: "string" },
              query: { type: "string", description: "What the user asked for." },
              suggestions: { type: "array", items: { type: "string" }, maxItems: 5, description: "Move ids from the candidate list." },
            },
          },
        },
      },
      async execute(_toolCallId, params) {
        ensureIndex();
        if (params.id) {
          const move = index.move(params.id);
          if (!move) return text(`No move with id "${params.id}". Use an id from the candidate list.`, { status: "bad_id" });
          return deliver(ctx, cardFor(move), { status: "match", id: move.id });
        }
        const nf = params.notFound;
        if (!nf) return text("Pass either id or notFound.", { status: "bad_args" });
        const known = new Set(index.characters().map((c) => c.name));
        const character = known.has(nf.character) ? nf.character : null;
        const suggestions = (nf.suggestions ?? []).map((id) => index.move(id)).filter(Boolean).slice(0, 5);
        const query = String(nf.query ?? "").replace(/\s+/g, " ").slice(0, 60);
        return deliver(ctx, formatSuggestions({ character, query, candidates: suggestions }), { status: "not_found" });
      },
    }), { names: ["tekken_pick_move"] });

    const ownerOnly = (handler) => async (ctx) => {
      if (ctx.senderIsOwner !== true) return { text: "⚠️ Owner only." };
      return handler(ctx);
    };
    const exclusive = async (label, fn) => {
      if (busy) return { text: `⏳ ${busy} already running.` };
      busy = label;
      try {
        return await fn();
      } catch (err) {
        return { text: `❌ ${label} failed: ${err.message}` };
      } finally {
        busy = null;
      }
    };
    coachTransport.registerCommands();

    api.registerCommand({
      name: "fd_sync",
      description: "Owner: fetch Wavu frame data, commit changes to git, rebuild the index (args: dry | force)",
      acceptsArgs: true,
      requireAuth: true,
      requiredScopes: ["operator.admin"],
      handler: ownerOnly((ctx) => exclusive("sync", async () => {
        const args = String(ctx.args ?? "").toLowerCase();
        const dry = args.includes("dry");
        const board = syncBoard(ctx, dry);
        let result;
        try {
          result = await sync(p, { dryRun: dry, force: args.includes("force"), progress: board });
          if (!dry && result.changed) {
            coachTransport.coach.cache.invalidate();
            const flagged = await coachTransport.tips.flagChangedMoves(result.digest ?? {});
            for (const tip of flagged ?? []) await coachTransport.notifyQueue(tip);
          }
        } catch (err) {
          board.skipRest();
          await board.finish(`❌ Sync failed: ${err.message}`);
          throw err;
        }
        if (!dry) {
          if (!fs.existsSync(p.dbPath)) rebuild(p);
          const now = new Date().toISOString();
          writeState(p.statePath, { pendingCharacters: [], lastSyncAt: now, lastWatchCheck: now });
          // GitHub push only after the whole fetch is committed
          board.update("push", "run", "waiting for the push service");
          const head = await headCommit(p.repoDir);
          const pushed = await pushAndWait(p.repoDir, head, { onWait: (s) => board.update("push", "run", `waiting for the push service · ${s}s`) });
          board.update("push", pushed.state, pushed.detail);
        } else {
          board.update("push", "skip", "dry run");
        }
        const failed = board.steps.some((s) => s.state === "fail" || s.state === "warn");
        await board.finish(failed ? "⚠️ Done with warnings — see above." : `✅ Done${dry ? " (dry run, nothing saved)" : ""}.`);
        let reply = `${result.changed ? "✅" : "ℹ️"} ${result.message}`;
        if (result.digest && hasFrameChanges(result.digest)) {
          const digestText = formatDigest(result.digest);
          if (dry) {
            reply += `\n\nDigest preview:\n${digestText}`;
          } else if (clanGroups().length) {
            // preview to the owner with a button; nothing reaches the clan until it's tapped
            const token = createToken(p.statePath, { kind: "post", text: digestText });
            const owner = digits(ctx.senderId) ?? ownerChatIdFrom(api);
            await sendMessage(owner, digestText, undefined, { replyMarkup: keyboard([{ text: "📢 Post to group", callback_data: postData(token) }]) })
              .catch((err) => api.logger?.warn?.(`tekken-fd digest preview failed: ${err.message}`));
            reply += "\n\n📢 Digest preview sent — tap “Post to group” to share it with the clan.";
          }
        }
        return { text: reply };
      })),
    });

    /** Live progress message in the chat that sent /fd_sync (sent once, then edited in place). */
    function syncBoard(ctx, dry) {
      const chatId = chatIdFrom(ctx.originatingTo ?? ctx.to) ?? digits(ctx.senderId);
      let messageId = null;
      const show = async (text) => {
        if (!chatId) return;
        try {
          if (messageId) await editMessageText(chatId, messageId, text);
          else messageId = (await sendMessage(chatId, text))?.message_id ?? null;
        } catch (err) {
          if (!/not modified/i.test(err.message)) api.logger?.warn?.(`tekken-fd sync progress: ${err.message}`);
        }
      };
      const board = new ProgressBoard(`🔄 ${dry ? "Sync preview (dry run)" : "Sync"}`, SYNC_STEPS, { show });
      board.flush(true);
      return board;
    }

    api.registerCommand({
      name: "fd_rebuild",
      description: "Owner: rebuild the frame-data index from the git snapshots (after a git revert)",
      requireAuth: true,
      requiredScopes: ["operator.admin"],
      handler: ownerOnly(() => exclusive("rebuild", async () => {
        const r = rebuild(p);
        coachTransport.coach.cache.invalidate();
        return { text: `✅ Index rebuilt: ${r.moves} moves, ${r.characters} characters.` };
      })),
    });

    api.registerCommand({
      name: "fd_status",
      description: "Owner: frame-data source, last sync commit and watcher state",
      requireAuth: true,
      requiredScopes: ["operator.admin"],
      handler: ownerOnly(async () => {
        ensureIndex();
        const meta = fs.existsSync(p.dbPath) ? index.meta() : {};
        const state = readState(p.statePath);
        const commit = await lastDataCommit(p.repoDir, p.dataDir);
        return {
          text: [
            `📚 Frame data: ${meta.moves ?? 0} moves, synced ${meta.syncedAt || "never"}`,
            `🔖 Last data commit: ${commit || "none"}`,
            pushStatusLine(p.repoDir, await headCommit(p.repoDir).catch(() => "")),
            `👀 Watcher last check: ${state.lastWatchCheck ?? "never"}`,
            `📝 Edited on Wavu since last sync: ${(state.pendingCharacters ?? []).join(", ") || "none"}`,
          ].join("\n"),
        };
      }),
    });

    api.registerCommand({
      name: "fd_stats",
      description: "Owner: usage stats (lookups, top moves, unknown words, model share)",
      requireAuth: true,
      requiredScopes: ["operator.admin"],
      handler: ownerOnly(async () => ({ text: stats.format() })),
    });

    api.registerCommand({
      name: "fd_check",
      description: "Owner: run the Wavu change watcher now",
      requireAuth: true,
      requiredScopes: ["operator.admin"],
      handler: ownerOnly(() => exclusive("check", async () => {
        const r = await checkOnce({ statePath: p.statePath, characters: characterNames(), ownerChatId: null, logger: api.logger });
        return { text: r.characters.length ? `📝 Edited since ${r.since.slice(0, 10)}: ${r.characters.join(", ")}. Send /fd_sync to update.` : `✅ No Tekken 8 movelist edits since ${r.since.slice(0, 10)}.` };
      })),
    });

    // Telegram command menus: everyone sees /start and /help; admins see the full list
    // (config/telegram-admin-commands.json) in their DM and in configured groups.
    const PUBLIC_COMMANDS = [
      { command: "start", description: "How to use the frame data bot" },
      { command: "help", description: "All commands with examples (!fd, !punish, !mu, !quiz …)" },
    ];
    async function syncCommandMenus() {
      let full = [];
      try {
        full = JSON.parse(fs.readFileSync(path.join(repoDir, "config", "telegram-admin-commands.json"), "utf8"));
      } catch (err) {
        api.logger?.warn?.(`tekken-fd: admin command list unreadable: ${err.message}`);
      }
      const adminMenu = [...PUBLIC_COMMANDS.filter((c) => !full.some((f) => f.command === c.command)), ...full].slice(0, 100);
      await setMyCommands(PUBLIC_COMMANDS, { type: "default" });
      const groups = Object.keys(api.config?.channels?.telegram?.groups ?? {}).filter((id) => /^-\d+$/.test(id));
      for (const admin of admins()) {
        await setMyCommands(adminMenu, { type: "chat", chat_id: Number(admin) });
        for (const g of groups) await setMyCommands(adminMenu, { type: "chat_member", chat_id: Number(g), user_id: Number(admin) });
      }
      api.logger?.info?.(`tekken-fd: command menus set (public ${PUBLIC_COMMANDS.length}, admin ${adminMenu.length}, groups ${groups.length})`);
    }
    let menuTimer = null;
    let statsTimer = null;

    let stopWatcher = null;
    api.registerService({
      id: "tekken-fd-watcher",
      start() {
        // after the Telegram provider has started (it may register its own menu on start)
        menuTimer = setTimeout(() => syncCommandMenus().catch((err) => api.logger?.warn?.(`tekken-fd: command menus failed: ${err.message}`)), 30_000);
        menuTimer.unref?.();
        statsTimer = setInterval(() => {
          try { stats.flush(); } catch (err) { api.logger?.warn?.(`tekken-fd stats flush failed: ${err.message}`); }
          // quizzes whose reveal timer was lost (restart) + the daily auto quiz in clan groups
          for (const q of quiz.overdue()) revealQuiz(q.id).catch(() => {});
          if (quizCfg.daily) {
            for (const g of clanGroups()) {
              if (!quiz.dueDaily(g, quizCfg)) continue;
              const pending = readState(p.statePath).pendingCharacters ?? [];
              const character = pending.length ? pending[Math.floor(Math.random() * pending.length)] : null;
              postQuiz(g, null, makeQuestion(index, { character })).catch((err) => api.logger?.warn?.(`tekken-fd daily quiz failed: ${err.message}`));
            }
          }
        }, 60_000);
        statsTimer.unref?.();
        try {
          ensureIndex();
        } catch (err) {
          api.logger?.warn?.(`tekken-fd: index build failed: ${err.message}`);
        }
        if (api.pluginConfig?.watcher === false) return;
        stopWatcher = startWatcher({
          statePath: p.statePath,
          getCharacters: () => characterNames(),
          ownerChatId: ownerChatIdFrom(api),
          logger: api.logger,
        });
      },
      async stop() {
        clearTimeout(menuTimer);
        clearInterval(statsTimer);
        try { stats.flush(); } catch {}
        stopWatcher?.();
        stopWatcher = null;
        await coachTransport.close();
        index.close();
      },
    });
  },
};
