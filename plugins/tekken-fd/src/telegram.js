// Minimal Telegram Bot API client (token from the gateway env; no dependencies).

async function call(method, body, { token = process.env.TELEGRAM_BOT_TOKEN, fetchImpl = fetch } = {}) {
  if (!token) throw new Error("telegram: TELEGRAM_BOT_TOKEN is not set");
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(`telegram ${method}: ${json.description ?? `HTTP ${res.status}`}`);
  return json.result;
}

/** Chat id from an OpenClaw conversation id ("telegram:-1001234", "-1001234:topic:5", "123456789"). */
export function chatIdFrom(conversationId) {
  const m = String(conversationId ?? "").match(/-?\d{5,}/);
  return m ? m[0] : null;
}

/** @param {{replyMarkup?: object}} [extra] */
export function sendMessage(chatId, text, opts, extra = {}) {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(extra.replyMarkup ? { reply_markup: extra.replyMarkup } : {}),
    ...(extra.parseMode ? { parse_mode: extra.parseMode } : {}),
  }, opts);
}

/** Reply threaded to `messageId`; still delivered if that message was deleted meanwhile. */
export function sendReply(chatId, messageId, text, opts, extra = {}) {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_parameters: { message_id: Number(messageId), allow_sending_without_reply: true },
    ...(extra.replyMarkup ? { reply_markup: extra.replyMarkup } : {}),
    ...(extra.parseMode ? { parse_mode: extra.parseMode } : {}),
  }, opts);
}

export function deleteMessage(chatId, messageId, opts) {
  return call("deleteMessage", { chat_id: chatId, message_id: Number(messageId) }, opts);
}

export function editMessageText(chatId, messageId, text, opts, extra = {}) {
  return call("editMessageText", {
    chat_id: chatId,
    message_id: Number(messageId),
    text,
    disable_web_page_preview: true,
    ...(extra.replyMarkup ? { reply_markup: extra.replyMarkup } : {}),
    ...(extra.parseMode ? { parse_mode: extra.parseMode } : {}),
  }, opts);
}

/** Display name of a chat member ("@nick" or first name). */
export async function memberName(chatId, userId, opts) {
  const r = await call("getChatMember", { chat_id: chatId, user_id: Number(userId) }, opts);
  const u = r?.user ?? {};
  return u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(" ") || String(userId);
}

/** Replace only the inline keyboard of a message (e.g. to mark a pressed button). */
export function editMessageReplyMarkup(chatId, messageId, replyMarkup, opts) {
  return call("editMessageReplyMarkup", { chat_id: chatId, message_id: Number(messageId), reply_markup: replyMarkup ?? { inline_keyboard: [] } }, opts);
}

/** First/last name only — never the @username or the numeric id (safe to publish). */
export async function memberDisplayName(chatId, userId, opts) {
  const r = await call("getChatMember", { chat_id: chatId, user_id: Number(userId) }, opts);
  const u = r?.user ?? {};
  return [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || null;
}

/** Verify membership before authorizing subscription-backed coach calls in DMs. */
export async function isChatMember(chatId, userId, opts) {
  const r = await call("getChatMember", { chat_id: chatId, user_id: Number(userId) }, opts);
  return ["creator", "administrator", "member"].includes(r?.status) || (r?.status === "restricted" && r.is_member === true);
}

/** Set the command menu for a scope ({type:"default"}, {type:"chat", chat_id}, {type:"chat_member", chat_id, user_id}). */
export function setMyCommands(commands, scope, opts) {
  return call("setMyCommands", { commands, scope }, opts);
}
