// End-to-end: the real plugin against a mocked OpenClaw plugin API and a mocked Telegram Bot API.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../index.js";
import { toPlain, isWellFormed } from "../src/render.js";
import { actionData, createToken } from "../src/buttons.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/Fahkumram.json", import.meta.url), "utf8"));
const OWNER = "100000001";
const FRIEND = "100000002";
const GROUP = "-1000000000001";

let tmp, hooks, commands, interactive, services, calls, nextId, realFetch;

function mockTelegram() {
  calls = [];
  nextId = 1000;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: nextId++ } }) };
  };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-plugin-"));
  const data = path.join(tmp, "repo", "data", "wavu", "t8");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "Fahkumram.json"), JSON.stringify(fx));
  const kz = (id, extra) => ({ id: `Kazuya-${id}`, num: "1", name: null, input: id, alias: null, alt: null, parent: null, target: "m", damage: "11", reach: null, tracksLeft: null, tracksRight: null, startup: "i15~16", recv: "r27", tot: "39", crush: null, block: "-7", hit: "+9", ch: null, notes: null, ...extra });
  fs.writeFileSync(path.join(data, "Kazuya.json"), JSON.stringify({ character: "Kazuya", game: "T8", source: "wavu.wiki", moves: [
    kz("df+1", { name: "Entrails Smash" }), kz("1", { target: "h", damage: "5", startup: "i10", block: "+1", hit: "+8" }),
    kz("db+4", { target: "l", damage: "14", startup: "i20", block: "-14", hit: "-3" }),
  ] }));
  fs.writeFileSync(path.join(data, "_meta.json"), JSON.stringify({ syncedAt: "2026-10-14T00:00:00Z" }));
  process.env.TELEGRAM_BOT_TOKEN = "T";
  mockTelegram();
  hooks = {};
  commands = {};
  services = [];
  plugin.register({
    pluginConfig: { repoDir: path.join(tmp, "repo"), stateDir: path.join(tmp, "state"), watcher: false },
    config: { commands: { ownerAllowFrom: [`telegram:${OWNER}`] }, channels: { telegram: { groups: { [GROUP]: {} } } } },
    logger: { info() {}, warn: (m) => process.env.FD_DEBUG && console.error("WARN", m) },
    resolvePath: (p) => path.join(ROOT, p),
    on: (name, fn) => { hooks[name] = fn; },
    registerTool() {},
    registerCommand: (c) => { commands[c.name] = c; },
    registerService: (s) => services.push(s),
    registerInteractiveHandler: (h) => { interactive = h; },
  });
});

after(async () => {
  for (const service of services) await service.stop();
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const send = (body, { sender = FRIEND, chat = GROUP, isGroup = true, agent = "fd", messageId = 7 } = {}) =>
  hooks.before_dispatch(
    { content: body, senderId: sender, isGroup, messageId: String(messageId), sessionKey: `agent:${agent}:telegram:${isGroup ? "group" : "direct"}:${chat}` },
    { channelId: "telegram", conversationId: chat },
  );
const lastSend = () => calls.filter((c) => c.method === "sendMessage").at(-1);
const plain = (c) => toPlain(c.body.text);

test("exact !fd → threaded card, no model", async () => {
  calls.length = 0;
  const r = await send("!fd Fahkumram 312");
  assert.deepEqual(r, { handled: true });
  const s = lastSend();
  assert.equal(s.body.reply_parameters.message_id, 7);
  assert.equal(s.body.parse_mode, "HTML");
  assert.ok(isWellFormed(s.body.text));
  assert.match(plain(s), /Fahkumram · 3,1,2 — Ayutthaya Piercing Thunder/);
  assert.match(plain(s), /i13, i18, i21~22/);
});

test("typo → suggestion buttons; only the asker can press; card replaces the suggestion", async () => {
  calls.length = 0;
  await send("!fd fahk 3,1,3", { messageId: 21 });
  const sugg = lastSend();
  assert.ok(sugg.body.reply_markup.inline_keyboard.flat().some((b) => b.text === "3,1,2"));
  const button = sugg.body.reply_markup.inline_keyboard.flat().find((b) => b.text === "3,1,2");
  const payload = button.callback_data.slice("tekken-fd:".length);
  assert.match(payload, /^a:/);
  let deleted = 0;
  const press = (sender) => interactive.handler({
    senderId: sender, callback: { payload }, respond: { deleteMessage: async () => { deleted++; }, clearButtons: async () => {} },
  });
  calls.length = 0;
  await press(OWNER); // not the asker
  assert.equal(deleted, 0);
  assert.equal(calls.length, 0);
  await press(FRIEND);
  assert.equal(deleted, 1);
  assert.match(plain(lastSend()), /Fahkumram · 3,1,2/);
  assert.equal(lastSend().body.reply_parameters.message_id, 21);
  await press(FRIEND); // token consumed
  assert.equal(deleted, 1);
});

test("fixing a typo by re-sending deletes the old suggestion", async () => {
  calls.length = 0;
  await send("!fd fahk 3,1,3", { messageId: 31 });
  const suggestionId = nextId - 1;
  await send("!fd fahk 312", { messageId: 32 });
  const del = calls.find((c) => c.method === "deleteMessage");
  assert.equal(del?.body.message_id, suggestionId);
});

test("!punish / !unsafe / !list answer deterministically", async () => {
  await send("!punish fahk -13");
  assert.match(plain(lastSend()), /Fahkumram — punish −13/);
  await send("!unsafe fahk -1");
  assert.match(plain(lastSend()), /unsafe on block/);
  await send("!list fahk mids");
  assert.match(plain(lastSend()), /Fahkumram — mids/);
  await send("!list fahk bananas");
  assert.match(plain(lastSend()), /Unknown filter “bananas”/);
});

test("public DM: non-commands get help, built-in commands don't pass", async () => {
  await send("hello", { chat: FRIEND, isGroup: false });
  assert.match(plain(lastSend()), /Tekken 8 frame data/);
  await send("/status", { chat: FRIEND, isGroup: false });
  assert.match(plain(lastSend()), /Tekken 8 frame data/);
  const r = await send("hello", { sender: OWNER, chat: OWNER, isGroup: false, agent: "main" });
  assert.equal(r, undefined); // owner's own agent is untouched
});

test("/fd_stats counts outcomes", async () => {
  const r = await commands.fd_stats.handler({ senderIsOwner: true });
  assert.match(r.text, /card \d+/);
  assert.match(r.text, /suggest \d+/);
  assert.match(r.text, /punish 1/);
});

test("!help lists commands; !help <cmd> gives details", async () => {
  await send("!help");
  assert.match(plain(lastSend()), /!punish <character> <frames>/);
  assert.match(plain(lastSend()), /!help <command>/);
  await send("!help list");
  assert.match(plain(lastSend()), /lows/);
  await send("!help punish", { chat: FRIEND, isGroup: false });
  assert.match(plain(lastSend()), /!punish lars 14/);
  await send("!help nonsense");
  assert.match(plain(lastSend()), /Tekken 8 frame data/);
});

test("!main sets a default character; an explicit character still wins", async () => {
  await send("!main fahk", { sender: "7770001", messageId: 50 });
  assert.match(plain(lastSend()), /Your main: Fahkumram/);
  await send("!punish -13", { sender: "7770001" });
  assert.match(plain(lastSend()), /Fahkumram — punish −13/);
  await send("!punish kazuya -13", { sender: "7770001" });
  assert.match(plain(lastSend()), /Kazuya — punish −13/);
  await send("!fd 312", { sender: "7770001" });
  assert.match(plain(lastSend()), /Fahkumram · 3,1,2/);
  await send("!fd kaz df1", { sender: "7770001" });
  assert.match(plain(lastSend()), /Kazuya · df\+1/);
  await send("!mains", { sender: "7770001" });
  assert.match(plain(lastSend()), /Fahkumram: /);
  await send("!mu kaz", { sender: "7770001" });
  assert.match(plain(lastSend()), /Fahkumram vs Kazuya — punish sheet/);
});

test("card buttons: only the asker can use them, navigation edits the card in place", async () => {
  calls.length = 0;
  await send("!fd fahk 3,1", { messageId: 60 });
  const card = lastSend();
  const btns = card.body.reply_markup.inline_keyboard.flat();
  assert.ok(btns.some((x) => x.text === "◀ 3"));
  const back = btns.find((x) => x.text === "◀ 3");
  const press = (sender) => interactive.handler({ senderId: sender, callback: { payload: back.callback_data.slice("tekken-fd:".length) }, respond: { deleteMessage: async () => {}, clearButtons: async () => {} } });
  calls.length = 0;
  await press(OWNER);
  assert.equal(calls.length, 0);
  await press(FRIEND);
  const edit = calls.find((c) => c.method === "editMessageText");
  assert.ok(edit, "card edited");
  assert.equal(edit.body.parse_mode, "HTML");
  assert.match(toPlain(edit.body.text), /Fahkumram · 3\n/);
});

test("quiz: anyone answers once; correct answers score; !top", async () => {
  calls.length = 0;
  await send("!quiz fahk", { messageId: 70 });
  const q = lastSend();
  assert.match(plain(q), /Quiz: Fahkumram/);
  const opts = q.body.reply_markup.inline_keyboard.flat();
  assert.equal(opts.length, 4);
  const pressOpt = (sender, b) => interactive.handler({ senderId: sender, senderUsername: `u${sender}`, callback: { payload: b.callback_data.slice("tekken-fd:".length) }, respond: {} });
  for (const [sender, b] of [["1100001", opts[0]], ["1200001", opts[1]], ["1300001", opts[2]], ["1100001", opts[3]]]) await pressOpt(sender, b);
  await send("!top");
  assert.match(plain(lastSend()), /Quiz leaderboard/);
});

test("several lookups in one message → one combined reply", async () => {
  await send("!fd fahk 312; kaz df1\n!punish fahk 13");
  const t = plain(lastSend());
  assert.match(t, /Fahkumram · 3,1,2/);
  assert.match(t, /Kazuya · df\+1/);
  assert.match(t, /Fahkumram — punish −13/);
  assert.ok(!lastSend().body.reply_markup);
});

test("Russian layout and Cyrillic names", async () => {
  calls.length = 0;
  await send("!ав афрл 312"); // "!fd fahk 312" typed on the Russian layout
  assert.equal(calls.length, 1);
  assert.match(plain(lastSend()), /Fahkumram · 3,1,2/);
  calls.length = 0;
  await send("!fd казуя df1");
  assert.equal(calls.length, 1);
  assert.match(plain(lastSend()), /Kazuya · df\+1/);
});

test("coach/tip buttons are asker-only like card buttons", async () => {
  const statePath = path.join(tmp, "state", "state.json");
  const token = createToken(statePath, { kind: "actions", chatId: GROUP, askerId: FRIEND, askerOnly: true, messageId: 50,
    actions: [{ type: "tipStart", target: { as: null, opponent: "Kazuya" } }] });
  const press = (sender) => interactive.handler({ senderId: sender, callback: { payload: actionData(token, 0).slice("tekken-fd:".length) },
    respond: { deleteMessage: async () => {}, clearButtons: async () => {} } });
  calls.length = 0;
  await press(OWNER); // an admin, but not the asker
  assert.equal(calls.length, 0);
  const own = createToken(statePath, { kind: "actions", chatId: GROUP, askerId: OWNER, askerOnly: true, messageId: 51,
    actions: [{ type: "tipStart", target: { as: null, opponent: "Kazuya" } }] });
  await interactive.handler({ senderId: OWNER, callback: { payload: actionData(own, 0).slice("tekken-fd:".length) },
    respond: { deleteMessage: async () => {}, clearButtons: async () => {} } });
  assert.match(plain(lastSend()), /!tip vs Kazuya: your advice/);
});
