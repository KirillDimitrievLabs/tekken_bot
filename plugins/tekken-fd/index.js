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
import { analyze, isHelpCommand, needMoveText, unknownCharacterText, unresolvedText, USAGE } from "./src/fastpath.js";
import { readMeta } from "./src/snapshot.js";
import { chatIdFrom, sendMessage, sendReply, setMyCommands } from "./src/telegram.js";
import { lastDataCommit, paths, rebuild, sync } from "./src/sync.js";
import { checkOnce, readState, startWatcher, writeState } from "./src/watcher.js";


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

    const cardFor = (move) => formatCard({ character: move.character, key: move.key, chain: index.chain(move.id) });
    const aliases = new AliasStore({
      curatedPath: api.resolvePath ? api.resolvePath("aliases.json") : path.join(repoDir, "plugins/tekken-fd/aliases.json"),
      addedPath: path.join(repoDir, "data", "aliases.json"),
      repoDir,
    });
    const digits = (v) => (String(v ?? "").match(/-?\d{5,}/) ?? [null])[0];
    const admins = () => new Set([ownerChatIdFrom(api), ...(api.pluginConfig?.adminIds ?? [])].filter(Boolean).map(String));
    // Agents whose sessions may hand vague !fd queries to the model; elsewhere the plugin answers itself.
    const reasoningAgents = api.pluginConfig?.fastPathAgents ?? ["fd"];
    const PUBLIC_AGENTS = api.pluginConfig?.publicAgents ?? ["fd"]; // DMs here only get !fd, /start, /help

    // Reply threaded to the asking message. The before_dispatch result can't carry a reply target,
    // so on Telegram the plugin sends via the Bot API (falling back to a plain gateway reply).
    const answer = async (event, ctx, text) => {
      const channel = String(ctx?.channelId ?? event?.channel ?? "");
      const chatId = chatIdFrom(ctx?.conversationId);
      const messageId = event?.messageId ?? ctx?.messageId;
      if (channel === "telegram" && chatId && /^\d+$/.test(String(messageId ?? ""))) {
        try {
          const sent = await sendReply(chatId, messageId, text);
          return { handled: true, sentId: sent?.message_id, chatId };
        } catch (err) {
          api.logger?.warn?.(`tekken-fd threaded reply failed (${err.message}); sending unthreaded`);
        }
      }
      return { handled: true, text };
    };
    const done = (r) => (r.text ? { handled: true, text: r.text } : { handled: true });

    // Pending "unknown character" requests waiting for an admin reply (persisted in state.json).
    const pendingAliases = () => (readState(p.statePath).pendingAliases ?? []).filter((x) => Date.now() - Date.parse(x.at) < 14 * 864e5);
    const savePending = (list) => writeState(p.statePath, { pendingAliases: list.slice(-100) });

    const helpText = [
      "🤖 Tekken 8 frame data",
      "",
      USAGE,
      "",
      "Character nicknames work too (fahk, kaz, dvj, …).",
      "Data: wavu.wiki",
    ].join("\n");

    async function handleAliasReply(event, ctx, pending) {
      const characters = characterNames();
      const parsed = parseAliasReply(event.content ?? event.body, pending.alias, aliases, characters);
      if (parsed.error) {
        const closest = resolveCharacter(pending.alias, characters, aliases.all()).candidates;
        const example = closest[0] ?? characters[0];
        const r = await answer(event, ctx, `❌ ${parsed.error}.${closest.length ? ` Closest: ${closest.join(" · ")}.` : ""}\nReply to this message with an exact name, e.g. "${example}" or "${pending.alias} = ${example}".`);
        // the correction may be a reply to this error message, too
        if (r.sentId && r.chatId) savePending([...pendingAliases(), { ...pending, chatId: r.chatId, messageId: r.sentId }]);
        return done(r);
      }
      const added = await aliases.add(parsed.alias, parsed.character, characters, { by: `telegram:${digits(event.senderId) ?? "?"}` });
      savePending(pendingAliases().filter((x) => !(x.at === pending.at && x.args === pending.args)));
      api.logger?.info?.(`tekken-fd alias added: ${added.alias} → ${added.character} (${added.commit})`);
      await answer(event, ctx, `✅ Alias added: ${added.alias} → ${added.character}${added.previous && added.previous !== added.character ? ` (was ${added.previous})` : ""}`);
      // Answer the original question now that the character is known.
      const retry = analyze(index, `!fd ${pending.args}`, aliases.all());
      const text = retry?.kind === "match" ? cardFor(retry.move)
        : retry?.kind === "need_move" ? needMoveText(retry.character)
        : retry?.kind === "unresolved" ? unresolvedText(retry) : null;
      if (text && pending.originalMessageId) {
        try {
          await sendReply(pending.askChatId ?? pending.chatId, pending.originalMessageId, text);
        } catch (err) {
          api.logger?.warn?.(`tekken-fd: re-answer failed: ${err.message}`);
        }
      }
      return { handled: true };
    }

    api.on("before_dispatch", async (event, ctx) => {
      const sessionKey = String(event?.sessionKey ?? "");
      const body = event?.content ?? event?.body;
      const isPublic = PUBLIC_AGENTS.some((id) => sessionKey.startsWith(`agent:${id}:`));
      const isDirect = event?.isGroup === false;
      const isAdmin = admins().has(String(digits(event?.senderId) ?? ""));
      const chatId = chatIdFrom(ctx?.conversationId);
      const started = Date.now();
      try {
        // 1) Admin replying to an "unknown character" request.
        const replyTo = String(event?.replyToId ?? "");
        if (replyTo && chatId) {
          const pending = pendingAliases().find((x) => x.chatId === chatId && String(x.messageId) === replyTo);
          if (pending) return isAdmin ? await handleAliasReply(event, ctx, pending) : { handled: true };
        }
        // 2) /start and /help: our help for everyone except the owner's own agent sessions.
        if (isHelpCommand(body) && (isPublic || !isAdmin)) return done(await answer(event, ctx, helpText));

        ensureIndex();
        const a = analyze(index, body, aliases.all());
        // 3) Not an !fd message: public DMs only get the help text; everything else passes through.
        if (!a) return isPublic && isDirect ? done(await answer(event, ctx, helpText)) : undefined;

        switch (a.kind) {
          case "match":
            api.logger?.info?.(`tekken-fd fast path: ${a.move.id} in ${Date.now() - started}ms (${sessionKey})`);
            return done(await answer(event, ctx, cardFor(a.move)));
          case "usage":
            return done(await answer(event, ctx, USAGE));
          case "need_move":
            return done(await answer(event, ctx, needMoveText(a.character)));
          case "unknown_character": {
            const base = { originalMessageId: event?.messageId ?? null, alias: a.token.toLowerCase(), args: a.args, at: new Date().toISOString() };
            // In groups and in an admin's own DM the admin can reply right there.
            if (!isDirect || isAdmin) {
              const r = await answer(event, ctx, unknownCharacterText(a));
              if (r.sentId && r.chatId) savePending([...pendingAliases(), { ...base, chatId: r.chatId, messageId: r.sentId, askChatId: r.chatId }]);
              return done(r);
            }
            // Someone else's DM: tell them an admin was asked, and send the request to the admins.
            const r = await answer(event, ctx, `❓ Unknown character: "${a.token.slice(0, 30)}". I've asked an admin to add it — you'll get the answer here.`);
            const who = digits(event?.senderId) ?? "?";
            for (const admin of admins()) {
              try {
                const closest = a.candidates.length ? `\nClosest: ${a.candidates.join(" · ")}` : "";
                const sent = await sendMessage(admin, `❓ Unknown character "${a.token.slice(0, 30)}" from user ${who}: "!fd ${a.args.slice(0, 80)}"${closest}\nReply to this message with the character name to add "${a.token.slice(0, 30).toLowerCase()}" as an alias.`);
                if (sent?.message_id) savePending([...pendingAliases(), { ...base, chatId: String(admin), messageId: sent.message_id, askChatId: r.chatId ?? chatId }]);
              } catch (err) {
                api.logger?.warn?.(`tekken-fd: alias request to admin ${admin} failed: ${err.message}`);
              }
            }
            return done(r);
          }
          case "unresolved":
            if (reasoningAgents.some((id) => sessionKey.startsWith(`agent:${id}:`))) return undefined; // model picks
            return done(await answer(event, ctx, unresolvedText(a)));
          default:
            return undefined;
        }
      } catch (err) {
        api.logger?.warn?.(`tekken-fd before_dispatch failed: ${err.message}`);
        return isPublic && isDirect ? { handled: true, text: helpText } : undefined;
      }
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

    api.registerCommand({
      name: "fd_sync",
      description: "Owner: fetch Wavu frame data, commit changes to git, rebuild the index (args: dry | force)",
      acceptsArgs: true,
      requireAuth: true,
      requiredScopes: ["operator.admin"],
      handler: ownerOnly((ctx) => exclusive("sync", async () => {
        const args = String(ctx.args ?? "").toLowerCase();
        const result = await sync(p, { dryRun: args.includes("dry"), force: args.includes("force") });
        if (!args.includes("dry")) {
          if (!fs.existsSync(p.dbPath)) rebuild(p);
          const now = new Date().toISOString();
          writeState(p.statePath, { pendingCharacters: [], lastSyncAt: now, lastWatchCheck: now });
        }
        return { text: `${result.changed ? "✅" : "ℹ️"} ${result.message}` };
      })),
    });

    api.registerCommand({
      name: "fd_rebuild",
      description: "Owner: rebuild the frame-data index from the git snapshots (after a git revert)",
      requireAuth: true,
      requiredScopes: ["operator.admin"],
      handler: ownerOnly(() => exclusive("rebuild", async () => {
        const r = rebuild(p);
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
            `👀 Watcher last check: ${state.lastWatchCheck ?? "never"}`,
            `📝 Edited on Wavu since last sync: ${(state.pendingCharacters ?? []).join(", ") || "none"}`,
          ].join("\n"),
        };
      }),
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
      { command: "help", description: "Usage: !fd <character> <move>" },
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

    let stopWatcher = null;
    api.registerService({
      id: "tekken-fd-watcher",
      start() {
        // after the Telegram provider has started (it may register its own menu on start)
        menuTimer = setTimeout(() => syncCommandMenus().catch((err) => api.logger?.warn?.(`tekken-fd: command menus failed: ${err.message}`)), 30_000);
        menuTimer.unref?.();
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
      stop() {
        clearTimeout(menuTimer);
        stopWatcher?.();
        stopWatcher = null;
        index.close();
      },
    });
  },
};
