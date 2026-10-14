import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Coach } from "./index.js";
import { Tips } from "../tips.js";
import { b, code, esc } from "../render.js";
import { formatMatchup } from "../matchup.js";
import { ProgressBoard } from "../progress.js";
import { chatIdFrom, editMessageText, isChatMember, memberDisplayName, sendMessage } from "../telegram.js";
import { guideCoverage } from "../guides.js";
import { readState, writeState } from "../watcher.js";
import { renderGuide } from "./render.js";

const run = promisify(execFile);
const title = (t) => t.as ? `${t.as} vs ${t.opponent}` : `vs ${t.opponent}`;
const sections = [["🛡 Defense", "defense"], ["💥 Punish", "punish"], ["⚔️ Neutral", "neutral"], ["🧱 Wall/Heat", "heat_and_wall"], ["🧪 Drill", "lab_drill"], ["📚 Full guide", "all"]];

export function createCoachTransport({ api, index, repoDir, stateDir, p, admins, clanGroups, mains, sendHtml, answer, done, ownerOnly, exclusive }) {
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
  const coachButtons = (key, target, userId) => {
    const actions = sections.map(([text, section]) => ({ text, action: { type: "coachSection", key, target, section } }));
    const rows = [actions.slice(0, 3), actions.slice(3)];
    rows.push([...[1, -1, 0].map((vote, i) => ({ text: ["👍", "👎", "⚠️ Something is wrong"][i], action: { type: "coachFeedback", key, vote, target } })),
      { text: "➕ Add tip", action: { type: "tipStart", target } }]);
    if (admins().has(String(userId))) rows.push([{ text: "🔄 Regenerate", action: { type: "coachGenerate", target, force: true } }]);
    return rows;
  };
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
    if (progressUsed) await board.finish(result.fallback ? "⚠️ Indexed fallback" : "✅ Guide ready");
    const buttons = result.key ? coachButtons(result.key, target, userId) : [];
    if (!target.as && mains.get(userId)) buttons.push([{ text: `🎓 As ${mains.get(userId)}`, action: { type: "coachGenerate", target: { ...target, as: mains.get(userId) } } }]);
    for (let i = 0; i < result.parts.length; i++) await sendHtml(chatId, replyTo, result.parts[i], { buttons: i === 0 ? buttons : [], askerId: String(userId), askerOnly: true });
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
      const detected = tip.detected?.map((m) => `${esc(m.input)} → ${esc(m.character)} ${code(m.key)}${m.startup ? ` (${esc(m.startup)}, ${esc(m.block ?? "?")})` : ""}`).join("\n");
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
      else if (a.type === "coachSection") {
        const hit = coach.cache.get(a.key, { count: false });
        if (!hit) { await sendHtml(t.chatId, t.messageId, "Guide changed; request it again."); return true; }
        const current = coach.dossier(a.target);
        if (coach.keyFor(a.target, current) !== a.key) { await sendHtml(t.chatId, t.messageId, "Data or coach settings changed; request the guide again."); return true; }
        const parts = renderGuide(index, hit.guide, current, { model: hit.model, createdAt: hit.created_at, section: a.section });
        // Reply sections so another reader's current view isn't overwritten.
        for (const html of parts) await sendHtml(t.chatId, t.messageId, html);
      } else if (a.type === "coachFeedback") {
        if (coach.cache.feedback(a.key, userId, a.vote)) {
          await sendHtml(t.chatId, t.messageId, "Feedback saved.");
          if (a.vote <= 0) for (const adminId of admins()) await sendHtml(adminId, null, `Coach feedback: ${a.vote === 0 ? "reported problem" : "👎"} · ${esc(title(a.target))}`, { askerOnly: false, buttons: [[{ text: "🔄 Regenerate", action: { type: "coachGenerate", target: a.target, force: true } }]] }).catch(() => {});
        }
      } else if (a.type === "tipStart") await sendHtml(t.chatId, t.messageId, `Submit with ${code(`!tip ${title(a.target)}: your advice`)}. Admin approval is required.`);
      else if (a.type === "tipConfirm") { const tip = tips.confirm(a.id, userId); await notifyQueue(tip); await sendHtml(t.chatId, t.messageId, "✅ Submitted to the admin queue."); }
      else if (a.type === "tipCancel") { tips.cancel(a.id, userId); await sendHtml(t.chatId, t.messageId, "Tip cancelled."); }
      else if (a.type === "tipVote") { const r = await tips.vote(a.id, userId, a.vote); if (r?.needsReview || r?.status === "needs-review") await notifyQueue(tips.get(a.id)); }
    } catch (e) { await sendHtml(t.chatId, t.messageId, `❌ ${esc(e.message)}`).catch(() => {}); }
    return true;
  }
  function registerCommands() {
    const register = (name, description, handler) => api.registerCommand({ name, description, acceptsArgs: true, requireAuth: true, requiredScopes: ["operator.admin"], handler: ownerOnly(handler) });
    register("coach_dossier", "Owner: inspect the raw coach dossier", async (ctx) => {
      const { parseCoachTarget } = await import("./commands.js");
      const target = parseCoachTarget(ctx.args, index.characters().map((c) => c.name), {});
      if (target.error) return { text: target.error };
      const d = coach.dossier({ ...target, language: "en", level: "mid" });
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
