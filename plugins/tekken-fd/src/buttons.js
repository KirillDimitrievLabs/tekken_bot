// Short-lived tokens behind inline buttons (Telegram callback_data is limited to 64 bytes).
import crypto from "node:crypto";
import { readState, writeState } from "./watcher.js";

export const NAMESPACE = "tekken-fd";
const TTL_MS = 24 * 60 * 60 * 1000;
const CAP = 300;

const live = (list, now = Date.now()) => (list ?? []).filter((t) => now - Date.parse(t.at) < TTL_MS);

export function allTokens(statePath) {
  return live(readState(statePath).buttons);
}

export function createToken(statePath, data) {
  const token = crypto.randomBytes(5).toString("base64url"); // 7 chars
  writeState(statePath, { buttons: [...allTokens(statePath), { ...data, token, at: new Date().toISOString() }].slice(-CAP) });
  return token;
}

export function getToken(statePath, token) {
  return allTokens(statePath).find((t) => t.token === token) ?? null;
}

export function updateToken(statePath, token, patch) {
  writeState(statePath, { buttons: allTokens(statePath).map((t) => (t.token === token ? { ...t, ...patch } : t)) });
}

export function removeTokens(statePath, predicate) {
  const keep = [];
  const removed = [];
  for (const t of allTokens(statePath)) (predicate(t) ? removed : keep).push(t);
  writeState(statePath, { buttons: keep });
  return removed;
}

/** callback_data for a choice / action. */
export const choiceData = (token, i) => `${NAMESPACE}:s:${token}:${i}`;
export const postData = (token) => `${NAMESPACE}:post:${token}`;

/** Parse the payload after "tekken-fd:" → {action, token, index}. */
export function parsePayload(payload) {
  const [action, token, index] = String(payload ?? "").split(":");
  return { action, token, index: index === undefined ? null : Number(index) };
}

/** Inline keyboard rows: up to 3 buttons per row. */
export function keyboard(buttons, perRow = 3) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return { inline_keyboard: rows };
}
