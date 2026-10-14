import assert from "node:assert/strict";
import { test } from "node:test";
import { chatIdFrom, sendReply } from "../src/telegram.js";

test("chat id from conversation ids", () => {
  assert.equal(chatIdFrom("telegram:100000001"), "100000001");
  assert.equal(chatIdFrom("-1001234567890"), "-1001234567890");
  assert.equal(chatIdFrom("telegram:group:-1001234567890:topic:5"), "-1001234567890");
  assert.equal(chatIdFrom(undefined), null);
});

test("reply is threaded to the asking message", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await sendReply("-100123456", "42", "card", { token: "T", fetchImpl });
  assert.match(sent.url, /\/botT\/sendMessage$/);
  assert.deepEqual(sent.body.reply_parameters, { message_id: 42, allow_sending_without_reply: true });
  assert.equal(sent.body.chat_id, "-100123456");
});
