// End-to-end: the real plugin against a mocked OpenClaw plugin API and a mocked Telegram Bot API.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import plugin from "../index.js";

const ROOT = new URL("..", import.meta.url).pathname;
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
  fs.writeFileSync(path.join(data, "_meta.json"), JSON.stringify({ syncedAt: "2026-10-14T00:00:00Z" }));
  process.env.TELEGRAM_BOT_TOKEN = "T";
  mockTelegram();
  hooks = {};
  commands = {};
  services = [];
  plugin.register({
    pluginConfig: { repoDir: path.join(tmp, "repo"), stateDir: path.join(tmp, "state"), watcher: false },
    config: { commands: { ownerAllowFrom: [`telegram:${OWNER}`] }, channels: { telegram: { groups: { [GROUP]: {} } } } },
    logger: { info() {}, warn() {} },
    resolvePath: (p) => path.join(ROOT, p),
    on: (name, fn) => { hooks[name] = fn; },
    registerTool() {},
    registerCommand: (c) => { commands[c.name] = c; },
    registerService: (s) => services.push(s),
    registerInteractiveHandler: (h) => { interactive = h; },
  });
});

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const send = (body, { sender = FRIEND, chat = GROUP, isGroup = true, agent = "fd", messageId = 7 } = {}) =>
  hooks.before_dispatch(
    { content: body, senderId: sender, isGroup, messageId: String(messageId), sessionKey: `agent:${agent}:telegram:${isGroup ? "group" : "direct"}:${chat}` },
    { channelId: "telegram", conversationId: chat },
  );
const lastSend = () => calls.filter((c) => c.method === "sendMessage").at(-1);

test("exact !fd → threaded card, no model", async () => {
  calls.length = 0;
  const r = await send("!fd Fahkumram 312");
  assert.deepEqual(r, { handled: true });
  const s = lastSend();
  assert.equal(s.body.reply_parameters.message_id, 7);
  assert.match(s.body.text, /command: 3,1,2/);
});

test("typo → suggestion buttons; only the asker can press; card replaces the suggestion", async () => {
  calls.length = 0;
  await send("!fd fahk 3,1,3", { messageId: 21 });
  const sugg = lastSend();
  assert.ok(sugg.body.reply_markup.inline_keyboard.flat().some((b) => b.text === "3,1,2"));
  const button = sugg.body.reply_markup.inline_keyboard.flat().find((b) => b.text === "3,1,2");
  const payload = button.callback_data.slice("tekken-fd:".length);
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
  assert.match(lastSend().body.text, /command: 3,1,2/);
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
  assert.match(lastSend().body.text, /Fahkumram — punish −13/);
  await send("!unsafe fahk -1");
  assert.match(lastSend().body.text, /unsafe on block/);
  await send("!list fahk mids");
  assert.match(lastSend().body.text, /Fahkumram — mids/);
  await send("!list fahk bananas");
  assert.match(lastSend().body.text, /Unknown filter "bananas"/);
});

test("public DM: non-commands get help, built-in commands don't pass", async () => {
  await send("hello", { chat: FRIEND, isGroup: false });
  assert.match(lastSend().body.text, /Tekken 8 frame data/);
  await send("/status", { chat: FRIEND, isGroup: false });
  assert.match(lastSend().body.text, /Tekken 8 frame data/);
  const r = await send("hello", { sender: OWNER, chat: OWNER, isGroup: false, agent: "main" });
  assert.equal(r, undefined); // owner's own agent is untouched
});

test("/fd_stats counts outcomes", async () => {
  const r = await commands.fd_stats.handler({ senderIsOwner: true });
  assert.match(r.text, /card \d+/);
  assert.match(r.text, /suggest \d+/);
  assert.match(r.text, /punish 1/);
});
