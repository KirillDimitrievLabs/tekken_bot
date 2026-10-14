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

/** Chat id from an OpenClaw conversation id ("telegram:-1001234", "-1001234:topic:5", "100000001"). */
export function chatIdFrom(conversationId) {
  const m = String(conversationId ?? "").match(/-?\d{5,}/);
  return m ? m[0] : null;
}

export function sendMessage(chatId, text, opts) {
  return call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }, opts);
}

/** Reply threaded to `messageId`; still delivered if that message was deleted meanwhile. */
export function sendReply(chatId, messageId, text, opts) {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_parameters: { message_id: Number(messageId), allow_sending_without_reply: true },
  }, opts);
}
