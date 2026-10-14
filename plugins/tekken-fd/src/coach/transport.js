import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Coach } from "./index.js";
import { Tips } from "../tips.js";
import { b, code, mk, esc } from "../render.js";
import { formatMatchup } from "../matchup.js";
import { ProgressBoard } from "../progress.js";
import { chatIdFrom, deleteMessage, editMessageReplyMarkup, editMessageText, isChatMember, memberDisplayName, sendMessage } from "../telegram.js";
import { updateToken } from "../buttons.js";
import { guideCoverage } from "../guides.js";
import { parseCoachTarget } from "./commands.js";
import { readState, writeState } from "../watcher.js";
import { availableViews, renderView, VIEWS } from "./render.js";
import { guideNodes, guideTitle, TelegraphClient } from "./telegraph.js";

const run = promisify(execFile);
const title = (t) => t.as ? `${t.as} vs ${t.opponent}` : `vs ${t.opponent}`;

export function createCoachTransport({ api, index, repoDir, stateDir, p, admins, clanGroups, mains, sendHtml, answer, done, markupFor, ownerOnly, exclusive }) {
  let coach;
  let warming = false;
  let commitChain = Promise.resolve();
  const commitTip = ({ relativePath, message }) => {
    const action = async () => {
      const git = (...args) => run("git", ["-C", repoDir, ...args]);
      await git("add", "--", relativePath);
      const diff = await git("diff", "--cached", "--name-only", "--", relativePath);
      if (diff.stdout.trim()) await git("commit", "--quiet", "--only", "-m", message, "--", relativePath);
    };
    const job = commitChain.then(action);
    commitChain = job.catch(() => {});
    return job;
  };
  const tips = new Tips({ repoDir, stateDir, index, commit: commitTip, onChange: () => coach?.invalidate() });
  coach = new Coach({ index, repoDir, stateDir, tips, config: api.pluginConfig?.coach ?? {}, logger: api.logger,
    complete: api.runtime?.llm?.complete ? (input) => api.runtime.llm.complete(input) : null });
  const cfg = () => api.pluginConfig?.coach ?? {};
  const telegraph = new TelegraphClient({ stateDir });
  const pageId = (target, mode) => JSON.stringify([mode, target.as ?? null, target.opponent, target.language ?? "en", target.level ?? "high"]);
  /** Publish (or update) the full guide on telegra.ph; returns its URL, or null if disabled/failed. */
  async function ensurePage(result, target) {
    if (cfg().telegraph === false || !result?.guide || !result.key) return null;
    const id = pageId(target, result.dossier.mode);
    const existing = coach.cache.page(id);
    if (existing?.key === result.key) return existing.url;
    try {
      const page = await telegraph.publish({ pagePath: existing?.path ?? null, title: guideTitle(result.dossier),
        content: guideNodes(index, result.guide, result.dossier, { model: result.model, createdAt: result.createdAt ?? result.created_at }) });
      coach.cache.setPage(id, { ...page, key: result.key });
      return page.url;
    } catch (err) {
      api.logger?.warn?.(`coach telegra.ph publish failed: ${err.message}`);
      return existing?.url ?? null;
    }
  }
  const pageUrl = (target, mode) => coach.cache.page(pageId(target, mode))?.url ?? null;
  const allowed = async (userId, chatId, { submissions = false, verifyMembership = false } = {}) => {
    if (!userId) return false;
    if (admins().has(String(userId))) return true;
    if (submissions && api.pluginConfig?.tips?.openSubmissions === true) return true;
    if (cfg().enabled !== true || (cfg().access ?? "admins") === "admins") return false;
    if ((cfg().allowlist ?? []).map(String).includes(String(userId))) return true;
    if (!verifyMembership && clanGroups().includes(String(chatId))) return true;
    for (const group of clanGroups()) if (await isChatMember(group, userId).catch(() => false)) return true;
    return false;
  };
  const preferences = (userId, target = {}) => ({ ...coach.cache.preference(userId), ...target });
  /**
   * Keyboard for one guide view: other views, pager, feedback, tip, admin regenerate.
   * Rebuilt on every view change; the token's action list is replaced to match.
   */
  const guideRows = ({ key, target, userId, guide, view = "overview", page = 0, pages = 1, voted = null, url = null }) => {
    const lang = target.language === "ru" ? "ru" : "en";
    const nav = availableViews(guide).filter((v) => v !== view && !(v === "plan" && !target.as))
      .map((v) => ({ text: VIEWS[v][lang], action: { type: "coachSection", key, target, section: v, page: 0 } }));
    const rows = url ? [[{ text: lang === "ru" ? "📖 Полный гайд" : "📖 Full guide", url }]] : [];
    for (let i = 0; i < nav.length; i += 3) rows.push(nav.slice(i, i + 3));
    if (pages > 1) {
      const pager = [];
      if (page > 0) pager.push({ text: `◀ ${page}/${pages}`, action: { type: "coachSection", key, target, section: view, page: page - 1 } });
      if (page < pages - 1) pager.push({ text: `${page + 2}/${pages} ▶`, action: { type: "coachSection", key, target, section: view, page: page + 1 } });
      rows.splice(url ? 1 : 0, 0, pager);
    }
    rows.push([1, -1, 0].map((vote, i) => ({ text: `${["👍", "👎", "⚠️ Wrong"][i]}${voted === vote ? " ✓" : ""}`, action: { type: "coachFeedback", key, vote, target, view, page } })));
    const extra = [{ text: lang === "ru" ? "➕ Совет" : "➕ Add tip", action: { type: "tipStart", target, key, view, page } }];
    if (!target.as && mains.get(userId)) extra.push({ text: `🎓 As ${mains.get(userId)}`, action: { type: "coachGenerate", target: { ...target, as: mains.get(userId) } } });
    if (admins().has(String(userId))) extra.push({ text: "🔄 Regenerate", action: { type: "coachGenerate", target, force: true } });
    rows.push(extra);
    return rows;
  };
  /** Edit a guide message in place and point its token at the new keyboard. */
  async function editGuide(t, html, rows, state) {
    updateToken(p.statePath, t.token, { actions: rows.flat().filter((x) => !x.url).map((x) => x.action), ...state });
    await editMessageText(t.chatId, t.messageId, html, undefined, { parseMode: "HTML", replyMarkup: markupFor(t.token, rows) });
  }
  async function postGuide(target, userId, chatId, replyTo, { force = false } = {}) {
    if (!await allowed(userId, chatId)) {
      const parts = coach.fallback(coach.dossier(target), "Coach is available to clan members (admin preview until launch).").parts;
      for (const html of parts) await sendHtml(chatId, replyTo, html);
      return;
    }
    const isAdmin = admins().has(String(userId));
    let messageId;
    let progressUsed = false;
    const board = new ProgressBoard(`🧠 ${title(target)}`, [["dossier", "Building dossier"], ["model", "Thinking"], ["check", "Checking"]], {
      show: async (text) => {
        if (messageId) await editMessageText(chatId, messageId, text).catch(() => {});
        else messageId = (await sendMessage(chatId, text))?.message_id;
      },
    });
    const result = await coach.generate(target, { userId, admin: isAdmin, force, progress: (id, state, text) => { progressUsed = true; return board.update(id, state, text); } });
    board.skipRest();
    // the guide replaces the "thinking" message: one message per guide
    if (progressUsed) {
      await board.flush(true);
      if (messageId) await deleteMessage(chatId, messageId).catch(() => {});
    }
    if (result.fallback || !result.key) {
      for (const html of result.parts) await sendHtml(chatId, replyTo, html);
      return;
    }
    const view = renderView(index, result.guide, result.dossier, { view: "overview", model: result.model, createdAt: result.createdAt ?? result.created_at });
    const url = await ensurePage(result, target);
    const rows = guideRows({ key: result.key, target, userId, guide: result.guide, view: "overview", page: view.page, pages: view.pages, url });
    await sendHtml(chatId, replyTo, view.html, { buttons: rows, askerId: String(userId), askerOnly: true, meta: { view: "overview", page: view.page } });
  }
  const tipHtml = (tip) => `${b(`${tip.id} · ${title(tip)} · ${tip.category}`)}\n${esc(tip.text)}\n<i>${esc(tip.author)} · ${esc(tip.status)}${tip.needsReview ? " · may be outdated" : ""}${tip.votes !== undefined ? ` · votes ${tip.votes}` : ""}</i>`;
  const queueButtons = (id) => [[{ text: "✅ Approve", action: { type: "tipApprove", id } }, { text: "✏️ Edit", action: { type: "tipEdit", id } },
    { text: "🏷 Category", action: { type: "tipCategory", id } }, { text: "❌ Reject", action: { type: "tipReject", id } }]];
  async function notifyQueue(tip) {
    for (const admin of admins()) await sendHtml(admin, null, tipHtml(tip), { buttons: queueButtons(tip.id), askerOnly: false }).catch((e) => api.logger?.warn?.(`tip queue delivery failed: ${e.message}`));
  }
  async function notifyAuthor(tip, message) {
    if (tip.userId ?? tip.authorId) await sendMessage(String(tip.userId ?? tip.authorId), message).catch(() => {});
  }
  const pendingReplies = () => (readState(p.statePath).tipReplies ?? []).filter((r) => Date.now() - r.at < 864e5);
  const saveReplies = (r) => writeState(p.statePath, { tipReplies: r.slice(-100) });
  async function askTipReply(t, userId, action) {
    const instruction = action.type === "tipEdit" ? "Reply with the corrected tip (20–400 characters)." : action.type === "tipCategory" ? "Reply with defense, punish, neutral, pressure, wall, heat, oki or general." : "Reply with the rejection reason.";
    const posted = await sendHtml(t.chatId, t.messageId, instruction, { askerId: userId });
    if (posted.messageId) saveReplies([...pendingReplies(), { chatId: t.chatId, messageId: String(posted.messageId), userId, id: action.id, action: action.type, at: Date.now() }]);
  }
  async function handleAdminReply(event, ctx, userId, replyTo) {
    const chatId = chatIdFrom(ctx.conversationId);
    const r = pendingReplies().find((r) => r.chatId === chatId && r.messageId === String(replyTo));
    if (!r) return false;
    if (r.userId !== userId || !admins().has(userId)) return true;
    const text = String(event.content ?? event.body ?? "").trim();
    try {
      if (r.action === "tipEdit") await tips.edit(r.id, text);
      else if (r.action === "tipCategory") await tips.setCategory(r.id, text.toLowerCase());
      else { const previous = tips.get(r.id); await tips.reject(r.id, text); await notifyAuthor(previous, `Tip ${r.id} rejected: ${text}`); }
      saveReplies(pendingReplies().filter((x) => !(x.chatId === r.chatId && x.messageId === r.messageId && x.userId === r.userId)));
      await answer(event, ctx, "✅ Tip updated.");
      if (r.action !== "tipReject") await sendHtml(chatId, event.messageId, tipHtml(tips.get(r.id)), { buttons: queueButtons(r.id), askerOnly: false });
    } catch (e) { await answer(event, ctx, `❌ ${esc(e.message)} Reply again to the prompt.`); }
    return true;
  }
  async function handle(r, event, ctx, userId) {
    const chatId = chatIdFrom(ctx.conversationId);
    if (String(ctx.channelId ?? event.channel) !== "telegram" || !chatId) return done(await answer(event, ctx, "Coach and clan tips work in Telegram."));
    if (r.kind === "coachPreference") {
      try { const p = coach.cache.setPreference(userId, r.preference); return done(await answer(event, ctx, `✅ Guide preference: ${esc(p.language)} · ${esc(p.level)}`)); }
      catch (e) { return done(await answer(event, ctx, esc(e.message))); }
    }
    if (r.kind === "coach") { await postGuide(preferences(userId, r.target), userId, chatId, event.messageId); return { handled: true }; }
    if (!await allowed(userId, chatId, { submissions: r.kind === "tip" })) return done(await answer(event, ctx, "Clan tips are available to clan members (admin preview until launch)."));
    if (r.kind === "tip") {
      // Approved tips are pushed to GitHub: credit the first/last name, never the @username or user id.
      const name = await memberDisplayName(chatId, userId).catch(() => null);
      let tip;
      try { tip = tips.draft({ ...r.tip, userId, author: name || "Clan member", dataVersion: index.meta().syncedAt }); }
      catch (e) { return done(await answer(event, ctx, `❌ ${esc(e.message)}`)); }
      const detected = tip.detected?.map((m) => `${esc(m.input)} → ${esc(m.character)} ${mk(m.character, m.key)}${m.startup ? ` (${esc(m.startup)}, ${esc(m.block ?? "?")})` : ""}`).join("\n");
      return done(await answer(event, ctx, `${tipHtml(tip)}${detected ? `\n\nI understood:\n${detected}` : "\nNo unambiguous move references detected; the admin will review the text."}`, { buttons: [[
        { text: "✅ Submit for review", action: { type: "tipConfirm", id: tip.id } }, { text: "Cancel", action: { type: "tipCancel", id: tip.id } }]] }));
    }
    if (r.kind === "mytips") {
      const own = tips.own(userId);
      for (const tip of own.slice(-20)) await sendHtml(chatId, event.messageId, tipHtml(tip));
      if (!own.length) await answer(event, ctx, "No tips submitted yet.");
    } else {
      const list = tips.approved(r.target.as, r.target.opponent);
      for (const tip of list.slice(0, 20)) await sendHtml(chatId, event.messageId, tipHtml(tip), { askerOnly: false, buttons: [[
        { text: "👍", action: { type: "tipVote", id: tip.id, vote: 1 } }, { text: "👎", action: { type: "tipVote", id: tip.id, vote: -1 } }]] });
      if (!list.length) await answer(event, ctx, "No approved tips yet. Use !tip vs <character>: your advice.");
    }
    return { handled: true };
  }
  async function action(a, t, userId) {
    if (!/^(coach|tip)/.test(a.type)) return false;
    try {
      const admin = admins().has(userId);
      if (["tipApprove", "tipEdit", "tipCategory", "tipReject"].includes(a.type)) {
        if (!admin) return true;
        if (a.type === "tipApprove") { const previous = tips.get(a.id); await tips.approve(a.id); await notifyAuthor(previous, `✅ Your tip ${a.id} was approved.`); await sendHtml(t.chatId, t.messageId, "✅ Tip approved and committed. It will be pushed with the next /fd_sync."); }
        else await askTipReply(t, userId, a);
        return true;
      }
      if (!await allowed(userId, t.chatId, { submissions: a.type === "tipConfirm", verifyMembership: true })) return true;
      if (a.type === "coachGenerate") await postGuide(preferences(userId, a.target), userId, t.chatId, t.messageId, { force: a.force });
      else if (a.type === "coachSection" || a.type === "coachFeedback" || a.type === "tipStart") {
        // all guide buttons edit the guide message itself
        const hit = a.key ? coach.cache.get(a.key, { count: false }) : null;
        const current = hit ? coach.dossier(a.target) : null;
        if (!hit || coach.keyFor(a.target, current) !== a.key) {
          await editMessageText(t.chatId, t.messageId, a.target?.language === "ru" ? "Данные или настройки изменились — запросите гайд заново." : "The data or guide settings changed — request the guide again.").catch(() => {});
          return true;
        }
        const view = a.type === "coachSection" ? a.section : (t.view ?? a.view ?? "overview");
        const page = a.type === "coachSection" ? (a.page ?? 0) : (t.page ?? a.page ?? 0);
        const r = renderView(index, hit.guide, current, { view, page, model: hit.model, createdAt: hit.created_at });
        let voted = t.voted ?? null;
        if (a.type === "coachFeedback" && coach.cache.feedback(a.key, userId, a.vote)) {
          voted = a.vote;
          if (a.vote <= 0) for (const adminId of admins()) await sendHtml(adminId, null, `Coach feedback: ${a.vote === 0 ? "reported problem" : "👎"} · ${esc(title(a.target))}`, { askerOnly: false, buttons: [[{ text: "🔄 Regenerate", action: { type: "coachGenerate", target: a.target, force: true } }]] }).catch(() => {});
        }
        const rows = guideRows({ key: a.key, target: a.target, userId, guide: hit.guide, view: r.view, page: r.page, pages: r.pages, voted, url: pageUrl(a.target, current.mode) });
        if (a.type === "coachFeedback") {
          // feedback only marks the pressed button; the text stays as it is
          updateToken(p.statePath, t.token, { actions: rows.flat().filter((x) => !x.url).map((x) => x.action), voted });
          await editMessageReplyMarkup(t.chatId, t.messageId, markupFor(t.token, rows));
        } else {
          const html = a.type === "tipStart"
            ? `${r.html}\n\n💡 ${a.target?.language === "ru" ? "Отправьте совет командой" : "Send your tip with"} ${code(`!tip ${title(a.target)}: …`)} ${a.target?.language === "ru" ? "— его проверит админ." : "— an admin reviews it."}`
            : r.html;
          await editGuide(t, html, rows, { view: r.view, page: r.page, voted });
        }
      }
      else if (a.type === "tipConfirm") { const tip = tips.confirm(a.id, userId); await notifyQueue(tip); await sendHtml(t.chatId, t.messageId, "✅ Submitted to the admin queue."); }
      else if (a.type === "tipCancel") { tips.cancel(a.id, userId); await sendHtml(t.chatId, t.messageId, "Tip cancelled."); }
      else if (a.type === "tipVote") { const r = await tips.vote(a.id, userId, a.vote); if (r?.needsReview || r?.status === "needs-review") await notifyQueue(tips.get(a.id)); }
    } catch (e) { await sendHtml(t.chatId, t.messageId, `❌ ${esc(e.message)}`).catch(() => {}); }
    return true;
  }
  function registerCommands() {
    const register = (name, description, handler) => api.registerCommand({ name, description, acceptsArgs: true, requireAuth: true, requiredScopes: ["operator.admin"], handler: ownerOnly(handler) });
    register("coach_dossier", "Owner: inspect the raw coach dossier", async (ctx) => {
      const target = parseCoachTarget(ctx.args, index.characters().map((c) => c.name), {});
      if (target.error) return { text: target.error };
      const d = coach.dossier({ ...target, language: "en", level: "high" });
      // Raw dossier is potentially too large for Telegram; expose bounded sections, never truncate mid-token.
      const chatId = chatIdFrom(ctx.originatingTo ?? ctx.to) ?? String(ctx.senderId).replace(/^telegram:/, "");
      for (const block of d.text.split(/(?=\n## )/)) {
        for (let start = 0; start < block.length; start += 3000) await sendHtml(chatId, null, `<pre>${esc(block.slice(start, start + 3000))}</pre>`);
      }
      return { text: `Dossier ${d.hash.slice(0, 12)} · ${d.coverage.level} · ${d.moves.size} move references.` };
    });
    register("coach_status", "Owner: coach coverage, cache and rollout status", async () => {
      // Coverage comes straight from the guide snapshot; building 42 dossiers would block the bot for ~15 s.
      const guides = coach.guides();
      const rows = index.characters().map(({ name }) => `${name}: ${guideCoverage(guides[name]).level}`);
      return { text: [`Coach: ${cfg().enabled === true ? "enabled" : "disabled"} · ${cfg().access ?? "admins"}`, `Model: ${cfg().model ?? "openai/gpt-6.1-sol"} · high`, JSON.stringify(coach.cache.stats()), ...rows].join("\n") };
    });
    register("tips_queue", "Owner: pending clan tips, oldest first", async (ctx) => {
      const chatId = chatIdFrom(ctx.originatingTo ?? ctx.to) ?? String(ctx.senderId).replace(/^telegram:/, "");
      const queue = tips.queue();
      for (const tip of queue.slice(0, 20)) await sendHtml(chatId, null, tipHtml(tip), { askerOnly: false, buttons: queueButtons(tip.id) });
      return { text: `${queue.length} tip(s) awaiting review${queue.length > 20 ? " (first 20 shown)" : ""}.` };
    });
    register("coach_probe", "Owner: test an isolated JSON completion (uses model quota)", async () => exclusive("coach probe", async () => {
      const started = Date.now();
      const response = await api.runtime.llm.complete({ model: coach.model("counter"), reasoning: "high", systemPrompt: "Return JSON only.", messages: [{ role: "user", content: 'Return exactly {"ok":true}.' }], execution: { mode: "isolated-agent-runtime", timeoutMs: 180000 } });
      const raw = response.text;
      return { text: `Probe: ${Date.now() - started}ms · ${String(raw).length} characters · execution owner ${response.execution?.owner ?? "unreported"} · JSON ${JSON.parse(raw).ok === true ? "ok" : "unexpected"}` };
    }));
    // Owner test run: generate listed guides in the background and post them to the owner's DM as members
    // would see them. Works from Telegram or `openclaw agent --message "/coach_test …"`.
    register("coach_test", "Owner: generate test guides to your DM (vs reina; jin vs reina --lang en)", async (ctx) => {
      const raw = String(ctx.args ?? "");
      const opts = raw.match(/--(?:lang|level)\s+\S+/gi)?.join(" ") ?? "";
      const specs = raw.replace(/--(?:lang|level)\s+\S+/gi, "").split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
      if (!specs.length || specs.length > 10) return { text: "Use /coach_test vs reina; jin vs reina [--lang en|ru] [--level high|mid] (1–10 guides; high is the default)." };
      const names = index.characters().map((c) => c.name);
      const targets = [];
      for (const spec of specs) {
        const t = parseCoachTarget(`${spec} ${opts}`, names, {});
        if (t.error) return { text: `${spec}: ${t.error}` };
        targets.push(t);
      }
      const owner = [...admins()][0];
      if (!owner) return { text: "No owner chat configured." };
      if (warming) return { text: "⏳ Coach warm/test already running." };
      warming = true;
      (async () => {
        try {
          for (let i = 0; i < targets.length; i++) {
            const target = preferences(owner, targets[i]);
            await sendMessage(owner, `🧪 Test ${i + 1}/${targets.length}: ${title(target)} (${target.language}, ${target.level}) — generating…`);
            let result;
            try { result = await coach.generate(target, { userId: owner, admin: true }); }
            catch (err) { await sendMessage(owner, `❌ ${title(target)}: ${err.message}`); continue; }
            const note = result.fallback ? `⚠️ Fallback: ${result.reason}` : `✅ ${result.cached ? "cached" : `generated in ${Math.round((result.latencyMs ?? 0) / 1000)}s`}`;
            await sendMessage(owner, `${title(target)}: ${note}`);
            if (result.fallback || !result.key) { for (const html of result.parts) await sendHtml(owner, null, html); continue; }
            const view = renderView(index, result.guide, result.dossier, { view: "overview", model: result.model, createdAt: result.createdAt ?? result.created_at });
            const url = await ensurePage(result, target);
            await sendHtml(owner, null, view.html, { buttons: guideRows({ key: result.key, target, userId: owner, guide: result.guide, page: view.page, pages: view.pages, url }),
              askerId: String(owner), askerOnly: true, meta: { view: "overview", page: view.page } });
          }
          await sendMessage(owner, `🧪 Coach test finished: ${targets.length} guide(s).`);
        } catch (err) {
          api.logger?.warn?.(`coach test failed: ${err.message}`);
        } finally { warming = false; }
      })();
      return { text: `Started ${targets.length} test guide(s); they will arrive in the owner's Telegram DM.` };
    });
    // Own lock: warming can take up to an hour and must not block /fd_sync, /fd_rebuild or /fd_check.
    register("coach_warm", "Owner: pre-generate clan mains (only on command)", async (ctx) => {
      if (String(ctx.args).trim() !== "mains") return { text: "Use /coach_warm mains." };
      if (warming) return { text: "⏳ Coach warm already running." };
      warming = true;
      try { return await warmMains(ctx); }
      catch (err) { return { text: `❌ coach warm failed: ${err.message}` }; }
      finally { warming = false; }
    });
  }
  async function warmMains(ctx) {
    const jobs = new Map();
    for (const group of clanGroups()) {
      const roster = mains.roster(group);
      for (const user of roster) for (const opponent of new Set(roster.map((u) => u.character))) {
        if (user.character === opponent) continue;
        const target = preferences(user.userId, { as: user.character, opponent });
        jobs.set(JSON.stringify(target), target);
      }
    }
    const chatId = chatIdFrom(ctx.originatingTo ?? ctx.to) ?? String(ctx.senderId).replace(/^telegram:/, "");
    let count = 0, failed = 0;
    const uncached = [...jobs.values()].filter((target) => !coach.cache.get(coach.keyFor(target), { count: false }));
    for (const target of uncached.slice(0, 30)) {
      const result = await coach.generate(target, { userId: ctx.senderId, admin: true });
      failed += Number(Boolean(result.fallback)); count++;
      await sendMessage(chatId, `Warm ${count}/${Math.min(uncached.length, 30)}: ${title(target)} · ${result.fallback ? "fallback" : result.cached ? "cached" : "ready"}`);
    }
    return { text: `Warmed ${count} guide(s), ${failed} fallbacks.${uncached.length > 30 ? " Command cap 30; rerun for remaining uncached targets." : ""}` };
  }
  return { coach, tips, allowed, handle, action, handleAdminReply, registerCommands, notifyQueue, close: () => coach.close() };
}
