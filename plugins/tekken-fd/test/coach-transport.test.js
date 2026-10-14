// Real routing, callbacks, SQLite cache and moderation commits, with only Telegram and completion mocked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import plugin from "../index.js";
import { toPlain } from "../src/render.js";
import { parseGuide } from "../src/guides.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OWNER = "100000001", MEMBER = "100000002", OTHER_MEMBER = "100000003", STRANGER = "100000009";
const GROUP = "-1000000000001";

const move = (character, key, extra) => ({ id: `${character}-${key}`, num: "1", name: null, input: key, alias: null, alt: null, parent: null,
  target: "m", damage: "17", startup: "i15", block: "-7", hit: "+5", ch: null, crush: null, notes: null, recv: "r27", tot: "40", ...extra });

function cannedGuide(input) {
  const russian = input.systemPrompt.includes("Пиши по-русски");
  return {
    summary: russian ? "Блокируйте отмеченную угрозу и проверяйте наказание в тренировке." : "Block the unsafe threat and verify the standing punish in practice.",
    key_threats: [{ move: "[[Kazuya-b+4]]", why: "Threatens a grounded hit.", answer: "Standing block, then punish.", reward: "Regain a turn." }],
    defense: [], punish: [{ move: "[[Kazuya-b+4]]", answer: "Block punish with a verified standing response.", priority: "high" }],
    lows: [], their_turn: "Respect [[Kazuya-1]] on block and check the followup in practice.", neutral: "Bait [[Kazuya-b+4]] outside its tested range.",
    heat_and_wall: "Heat and wall-specific options are missing from this snapshot.", common_mistakes: [],
    lab_drill: ["Record [[Kazuya-b+4]] and practice a standing block punish; vary the recording."], confidence: "low",
    gaps: ["Community guides, exact reach and detailed strings are not indexed."], used_tips: [], used_guides: [],
  };
}

function harness(t, { access = "clan", enabled = true, beforeTelegramResult = async () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-coach-transport-"));
  const repoDir = path.join(dir, "repo"), stateDir = path.join(dir, "state");
  const data = path.join(repoDir, "data/wavu/t8"), tipFile = path.join(repoDir, "data/tips/t8-tips.json");
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(path.dirname(tipFile), { recursive: true });
  fs.writeFileSync(tipFile, "[]\n");
  for (const character of ["Kazuya", "Reina"]) {
    fs.writeFileSync(path.join(data, `${character}.json`), JSON.stringify({ character, game: "T8", source: "wavu.wiki", moves: [
      move(character, "1", { target: "h", damage: "5", startup: "i10", block: "+1", hit: "+8" }),
      move(character, "b+4", { block: "-13" }), move(character, "df+1", { startup: "i13" }),
    ] }));
  }
  fs.writeFileSync(path.join(data, "_meta.json"), JSON.stringify({ syncedAt: "2026-10-14T00:00:00Z" }));
  const git = (...args) => execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" }).toString().trim();
  git("init", "-q"); git("config", "user.email", "coach-test@example.com"); git("config", "user.name", "Coach test");
  git("add", "--", "data"); git("commit", "-q", "-m", "test fixtures");
  const calls = [], completions = [], warnings = [], members = new Map([[MEMBER, "member"], [OTHER_MEMBER, "member"], [OWNER, "administrator"]]);
  const realFetch = globalThis.fetch, oldToken = process.env.TELEGRAM_BOT_TOKEN;
  let nextId = 1000, interactive, hooks = {}, commands = {}, services = [];
  process.env.TELEGRAM_BOT_TOKEN = "coach-test-token";
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/api\.telegram\.org\/botcoach-test-token\//);
    const method = String(url).split("/").pop(), body = JSON.parse(init.body), messageId = nextId++;
    const call = { method, body, messageId, completed: false }; calls.push(call);
    await beforeTelegramResult(call);
    const result = method === "getChatMember" ? { status: members.get(String(body.user_id)) ?? "left", user: { first_name: "Alex" } } : { message_id: messageId };
    return { ok: true, json: async () => { call.completed = true; return { ok: true, result }; } };
  };
  const api = {
    pluginConfig: { repoDir, stateDir, watcher: false, coach: { enabled, access } },
    config: { commands: { ownerAllowFrom: [`telegram:${OWNER}`] }, channels: { telegram: { groups: { [GROUP]: {} } } } },
    runtime: { llm: { complete: async (input) => { completions.push(input); return { text: JSON.stringify(cannedGuide(input)) }; } } },
    logger: { info() {}, warn: (message) => { warnings.push(message); if (process.env.FD_DEBUG) console.error(message); } }, resolvePath: (file) => path.join(ROOT, file),
    on: (name, fn) => { hooks[name] = fn; }, registerTool() {}, registerCommand: (command) => { commands[command.name] = command; },
    registerService: (service) => services.push(service), registerInteractiveHandler: (handler) => { interactive = handler; },
  };
  plugin.register(api);
  t.after(async () => {
    for (const service of services) await service.stop();
    globalThis.fetch = realFetch;
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const send = (content, { sender = MEMBER, chat = GROUP, isGroup = chat === GROUP, messageId = 7, replyToId } = {}) => hooks.before_dispatch(
    { content, senderId: sender, isGroup, messageId: String(messageId), replyToId, sessionKey: `agent:fd:telegram:${isGroup ? "group" : "direct"}:${chat}` },
    { channelId: "telegram", conversationId: chat });
  const sent = (chat) => calls.filter((call) => call.method === "sendMessage" && (!chat || String(call.body.chat_id) === String(chat)));
  const lastSend = (chat) => sent(chat).at(-1);
  const press = (button, sender = MEMBER) => {
    assert(button?.callback_data, "expected a callback button");
    return interactive.handler({ senderId: sender, callback: { payload: button.callback_data.slice("tekken-fd:".length) }, respond: { clearButtons: async () => {}, deleteMessage: async () => {} } });
  };
  const button = (call, label) => call?.body.reply_markup?.inline_keyboard.flat().find((item) => item.text === label);
  const state = () => JSON.parse(fs.readFileSync(path.join(stateDir, "tips-state.json"), "utf8"));
  const query = (sql) => { const db = new DatabaseSync(path.join(stateDir, "coach.sqlite"), { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const stop = async () => { for (const service of services) await service.stop(); services = []; };
  const restart = async () => { await stop(); hooks = {}; commands = {}; plugin.register(api); };
  return { repoDir, stateDir, tipFile, api, calls, completions, warnings, members, git, send, sent, lastSend, press, button, state, query, restart, stop, commands };
}

const plain = (call) => toPlain(call?.body.text ?? "");

test("tip confirmation and admin approval route through real callbacks and a narrow private-safe commit", async (t) => {
  const h = harness(t);
  await h.send("!tip vs kazuya #defense: Block b+4 and use a standing punish to stop pressure.");
  const draftCard = h.lastSend(GROUP), confirm = h.button(draftCard, "✅ Submit for review");
  assert.match(plain(draftCard), /I understood:/);
  assert.equal(Object.values(h.state().tips)[0].status, "draft");
  await h.press(confirm, OTHER_MEMBER);
  assert.equal(Object.values(h.state().tips)[0].status, "draft");
  await h.press(confirm);
  assert.equal(Object.values(h.state().tips)[0].status, "pending");
  const queueCard = h.sent(OWNER).find((call) => h.button(call, "✅ Approve"));
  assert(queueCard, "admin receives review queue card");
  const approve = h.button(queueCard, "✅ Approve");
  await h.press(approve, MEMBER);
  assert.equal(Object.values(h.state().tips)[0].status, "pending");
  await h.press(approve, OWNER);
  assert.equal(Object.values(h.state().tips)[0].status, "approved");
  const publicTips = fs.readFileSync(h.tipFile, "utf8");
  assert.match(publicTips, /\[\[Kazuya-b\+4\]\]/); assert.match(publicTips, /"author": "Alex"/);
  assert.doesNotMatch(publicTips, new RegExp(`${OWNER}|${MEMBER}|userId|votes|detected`));
  assert.equal(h.git("show", "--format=", "--name-only", "HEAD"), "data/tips/t8-tips.json");
  assert.match(plain(h.lastSend(MEMBER)), /was approved/);
  assert.equal(h.completions.length, 0);
});

test("admin reply edit, category and rejection consume their prompts and reject another user's reply", async (t) => {
  const h = harness(t);
  await h.send("!tip vs kazuya: Block b+4 and test a standing punish in practice.");
  await h.press(h.button(h.lastSend(GROUP), "✅ Submit for review"));
  const queueCard = h.lastSend(OWNER);
  await h.press(h.button(queueCard, "✏️ Edit"), OWNER);
  const editPrompt = h.lastSend(OWNER);
  await h.send("Wrong user must never be able to edit the submitted tip.", { sender: STRANGER, chat: OWNER, replyToId: editPrompt.messageId });
  assert.match(Object.values(h.state().tips)[0].text, /Kazuya-b\+4/);
  await h.send("Use df+1 at the tested range after blocking their pressure.", { sender: OWNER, chat: OWNER, replyToId: editPrompt.messageId });
  assert.match(Object.values(h.state().tips)[0].text, /Kazuya-df\+1/);
  let privateState = JSON.parse(fs.readFileSync(path.join(h.stateDir, "state.json"), "utf8"));
  assert.equal(privateState.tipReplies.length, 0, "successful edit consumes its reply prompt");
  await h.press(h.button(h.lastSend(OWNER), "🏷 Category"), OWNER);
  const categoryPrompt = h.lastSend(OWNER);
  await h.send("punish", { sender: OWNER, chat: OWNER, replyToId: categoryPrompt.messageId });
  assert.equal(Object.values(h.state().tips)[0].category, "punish");
  await h.press(h.button(h.lastSend(OWNER), "❌ Reject"), OWNER);
  const rejectPrompt = h.lastSend(OWNER);
  await h.send("Please verify the spacing before resubmitting.", { sender: OWNER, chat: OWNER, replyToId: rejectPrompt.messageId });
  const tip = Object.values(h.state().tips)[0];
  assert.equal(tip.status, "rejected"); assert.match(tip.rejectionReason, /verify the spacing/);
  privateState = JSON.parse(fs.readFileSync(path.join(h.stateDir, "state.json"), "utf8"));
  assert.equal(privateState.tipReplies.length, 0, "successful rejection consumes its reply prompt");
  assert.deepEqual(JSON.parse(fs.readFileSync(h.tipFile, "utf8")), []);
  assert.match(plain(h.lastSend(MEMBER)), /rejected: Please verify/);
});

test("invalid tip submission returns a handled validation error without model fallback", async (t) => {
  const h = harness(t);
  assert.deepEqual(await h.send("!tip vs kazuya: too short"), { handled: true });
  assert.match(plain(h.lastSend(GROUP)), /20–400/);
  assert.equal(h.completions.length, 0);
});

test("DM coach authorizes current clan membership before generation and before a cached request", async (t) => {
  const h = harness(t);
  await h.send("!vs kazuya", { sender: STRANGER, chat: STRANGER });
  assert.equal(h.completions.length, 0); assert.match(plain(h.lastSend(STRANGER)), /available to clan members/);
  assert(h.calls.some((call) => call.method === "getChatMember" && call.body.user_id === Number(STRANGER)));
  await h.send("!vs kazuya", { sender: MEMBER, chat: MEMBER });
  assert.equal(h.completions.length, 1); assert.match(plain(h.lastSend(MEMBER)), /🎓/);
  assert.equal(h.completions[0].model, "openai/gpt-6.1-sol"); assert.equal(h.completions[0].reasoning, "high");
  assert(h.query("SELECT key FROM coach_cache").length === 1, h.warnings.join("\n"));
  const memberChecks = h.calls.filter((call) => call.method === "getChatMember" && call.body.user_id === Number(MEMBER)).length;
  await h.send("!vs kazuya", { sender: MEMBER, chat: MEMBER });
  assert.equal(h.completions.length, 1, "authorized repeat uses cache");
  assert(h.calls.filter((call) => call.method === "getChatMember" && call.body.user_id === Number(MEMBER)).length > memberChecks);
  h.members.set(MEMBER, "left");
  await h.send("!vs kazuya", { sender: MEMBER, chat: MEMBER });
  assert.match(plain(h.lastSend(MEMBER)), /available to clan members/);
  assert.equal(h.completions.length, 1, "former member does not access a generated or cached guide");
  await h.send("!vs kazuya", { sender: STRANGER, chat: STRANGER });
  assert.match(plain(h.lastSend(STRANGER)), /available to clan members/);
  assert.equal(h.completions.length, 1);
  assert.doesNotMatch(h.completions[0].messages[0].content, new RegExp(`${OWNER}|${MEMBER}|${STRANGER}|${GROUP}`));
});

test("guide language and level choices persist; explicit language overrides only that request", async (t) => {
  const h = harness(t);
  await h.send("!coachlang ru"); await h.send("!coachlevel high");
  assert.match(plain(h.lastSend(GROUP)), /ru · high/);
  await h.send("!vs kazuya");
  assert.equal(h.completions.length, 1); assert.match(h.completions[0].systemPrompt, /Пиши по-русски/);
  assert.match(h.completions[0].systemPrompt, /Reader level: high/);
  assert.match(plain(h.lastSend(GROUP)), /Против Kazuya/);
  await h.send("!vs kazuya --lang en");
  assert.equal(h.completions.length, 2); assert.match(h.completions[1].systemPrompt, /Write in English/);
  assert.match(plain(h.lastSend(GROUP)), /Against Kazuya/);
  assert.deepEqual(h.query("SELECT language,level FROM coach_users WHERE user_id='100000002'").map((row) => ({ ...row })), [{ language: "ru", level: "high" }]);
  await h.restart(); await h.send("!vs kazuya");
  assert.equal(h.completions.length, 2, "persisted Russian choice uses the Russian cache after restart");
  assert.match(plain(h.lastSend(GROUP)), /Против Kazuya/);
});

test("section and feedback callbacks check current access, including an old clan-group token", async (t) => {
  const h = harness(t);
  await h.send("!vs kazuya");
  assert.equal(h.completions.length, 1);
  const guideCard = h.lastSend(GROUP), defense = h.button(guideCard, "🛡 Defense"), feedback = h.button(guideCard, "👎");
  assert(defense); assert(feedback);
  const sentBefore = h.sent().length;
  await h.press(defense, STRANGER); await h.press(feedback, STRANGER);
  assert.equal(h.sent().length, sentBefore, "stranger cannot use a stored clan-group token");
  assert.equal(h.query("SELECT user_id FROM coach_feedback").length, 0);
  await h.press(defense, MEMBER);
  assert.match(plain(h.lastSend(GROUP)), /🎓/);
  await h.press(feedback, MEMBER);
  assert.deepEqual(h.query("SELECT user_id,vote FROM coach_feedback").map((row) => ({ ...row })), [{ user_id: MEMBER, vote: -1 }]);
  assert.match(plain(h.lastSend(OWNER)), /Coach feedback/);
  h.members.set(MEMBER, "left");
  const afterFeedback = h.sent().length;
  await h.press(defense, MEMBER); await h.press(h.button(guideCard, "👍"), MEMBER);
  assert.equal(h.sent().length, afterFeedback, "removed member cannot use an old guide token");
  assert.equal(h.query("SELECT vote FROM coach_feedback")[0].vote, -1);
  assert.equal(h.completions.length, 1, "sections and feedback never invoke a completion");
});

test("admin preview blocks members and strangers but permits owner generation", async (t) => {
  const h = harness(t, { access: "admins" });
  await h.send("!vs kazuya"); assert.equal(h.completions.length, 0);
  assert.match(plain(h.lastSend(GROUP)), /admin preview/);
  await h.send("!vs kazuya", { sender: OWNER, chat: OWNER });
  assert.equal(h.completions.length, 1);
});

test("delayed Telegram progress finishes before the final guide and never leaves a thinking message", async (t) => {
  let started, release;
  const progressStarted = new Promise((resolve) => { started = resolve; });
  const progressGate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const h = harness(t, { beforeTelegramResult: async (call) => {
    if (call.method === "sendMessage" && call.body.text.startsWith("🧠")) { started(); await progressGate; }
  } });
  let requestFinished = false;
  const request = h.send("!vs kazuya").then((result) => { requestFinished = true; return result; });
  await progressStarted; await nextTurn();
  assert.equal(h.completions.length, 1, "completion can finish while Telegram's initial progress post is delayed");
  const prematureGuide = h.sent(GROUP).some((call) => plain(call).startsWith("🎓"));
  release();
  const finishedBeforeRelease = requestFinished;
  await request;
  assert.equal(prematureGuide, false, "final guide waits for the progress post and its ready edit");
  assert.equal(finishedBeforeRelease, false);
  const readyIndex = h.calls.findIndex((call) => call.method === "editMessageText" && /Guide ready/.test(call.body.text));
  const guideIndex = h.calls.findIndex((call) => call.method === "sendMessage" && plain(call).startsWith("🎓"));
  assert(readyIndex >= 0 && guideIndex > readyIndex, "ready progress is edited before the final guide is sent");
  assert.equal(h.calls[readyIndex].completed, true);
  assert.match(h.calls.filter((call) => call.method === "editMessageText").at(-1).body.text, /Guide ready/);
  assert.equal(h.calls.slice(guideIndex + 1).filter((call) => call.method === "editMessageText").length, 0);
});

test("section callback refuses its old key when guide source data changed outside the cache", async (t) => {
  const h = harness(t);
  await h.send("!vs kazuya");
  const card = h.lastSend(GROUP), section = h.button(card, "💥 Punish"), oldKey = h.query("SELECT key FROM coach_cache")[0].key;
  const source = { Kazuya: { counterplay: parseGuide("== Punishment ==\nBlock b+4 and verify that the standing punish reaches at the recorded spacing.", "Kazuya", "counterplay") } };
  fs.writeFileSync(path.join(h.repoDir, "data/wavu/t8-guides.json"), JSON.stringify(source));
  const count = h.sent().length;
  await h.press(section);
  assert.equal(h.sent().length, count + 1);
  assert.match(plain(h.lastSend(GROUP)), /changed; request the guide again/);
  assert.equal(h.query("SELECT key FROM coach_cache")[0].key, oldKey, "stale cache row remains to prove the callback checks provenance");
  assert.equal(h.completions.length, 1, "stale section does not regenerate automatically");
  await h.send("!vs kazuya");
  assert.equal(h.completions.length, 2);
  assert(h.query("SELECT key FROM coach_cache").some((row) => row.key !== oldKey));
  assert.match(plain(h.lastSend(GROUP)), /🎓/);
});

test("recognized coach and tip commands remain handled when the snapshot and frame index are unavailable", async (t) => {
  const h = harness(t);
  await h.send("!vs kazuya"); assert.equal(h.completions.length, 1);
  await h.stop(); // Close every index handle before removing this test's files on Windows.
  const dataDir = path.resolve(h.repoDir, "data/wavu/t8"), dbFile = path.resolve(h.stateDir, "t8.sqlite");
  for (const [root, target] of [[h.repoDir, dataDir], [h.stateDir, dbFile]]) {
    const relative = path.relative(path.resolve(root), target);
    assert(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "test removal stays inside its own isolated repository/state");
  }
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(dbFile, { force: true });
  await h.restart();
  for (const [command, expected] of [
    ["!vs kazuya", /Coach data is unavailable/], ["!coach reina vs kazuya", /Coach data is unavailable/],
    ["!coachlang ru", /Guide preference: ru/], ["!coachlevel high", /Guide preference: ru · high/],
    ["!tip vs kazuya: Check a specific standing punish in practice.", /Coach data is unavailable/],
    ["!tips vs kazuya", /Coach data is unavailable/], ["!mytips", /No tips submitted/], ["!мы kazuya", /Coach data is unavailable/],
  ]) {
    const result = await h.send(command);
    assert.equal(result?.handled, true, `${command} must not fall through to the agent model`);
    assert.match(result.text ?? plain(h.lastSend(GROUP)), expected, `${command} has a deterministic reply`);
  }
  assert.equal(h.completions.length, 1, "unavailable data never starts another completion");
});
