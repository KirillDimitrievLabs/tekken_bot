// Daily Wavu change watcher: tells the owner which T8 movelists were edited. Never syncs by itself.
import fs from "node:fs";
import { sendMessage } from "./telegram.js";
import { fetchChangedCharacters } from "./wavu.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

export function writeState(statePath, patch) {
  const next = { ...readState(statePath), ...patch };
  fs.writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Plain-text Telegram DM to the owner. */
export async function notifyTelegram(chatId, text, opts) {
  if (!chatId) throw new Error("telegram notify: missing owner chat id");
  await sendMessage(chatId, text, opts);
}

/**
 * One watcher pass. Records lastWatchCheck and accumulates pendingCharacters until the next /fd_sync.
 * @returns {Promise<{characters: string[], since: string, notified: boolean}>}
 */
export async function checkOnce({ statePath, characters, ownerChatId, logger, fetchImpl, notify = notifyTelegram }) {
  const state = readState(statePath);
  const now = new Date();
  const since = state.lastWatchCheck ?? new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const { characters: changed } = await fetchChangedCharacters(since, characters, { fetchImpl });
  const pending = [...new Set([...(state.pendingCharacters ?? []), ...changed])].sort();
  writeState(statePath, { lastWatchCheck: now.toISOString(), pendingCharacters: pending });
  let notified = false;
  if (changed.length > 0 && ownerChatId) {
    await notify(ownerChatId, `📝 Wavu: ${changed.join(", ")} movelist/combo/punisher page(s) edited since ${since.slice(0, 10)}.\nSend /fd_sync to update the bot (or /fd_sync dry to preview).`);
    notified = true;
  }
  logger?.info?.(`tekken-fd watcher: ${changed.length} changed character(s) since ${since}`);
  return { characters: changed, since, notified };
}

/** Timer loop: first pass after `initialDelayMs`, then every `intervalMs`; only runs when a day has passed. */
export function startWatcher(opts, { intervalMs = 60 * 60 * 1000, initialDelayMs = 5 * 60 * 1000 } = {}) {
  let stopped = false;
  let timer;
  const tick = async () => {
    if (stopped) return;
    try {
      const last = readState(opts.statePath).lastWatchCheck;
      if (!last || Date.now() - Date.parse(last) >= DAY_MS) await checkOnce({ ...opts, characters: opts.getCharacters() });
    } catch (err) {
      opts.logger?.warn?.(`tekken-fd watcher failed: ${err.message}`);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, initialDelayMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
