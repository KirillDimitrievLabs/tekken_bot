// GitHub push hand-off. The deploy key never enters the container: the bot drops a request file,
// a host service (scripts/push/, systemd tekken-bot-push.path) pushes and writes back a status file.
import fs from "node:fs";
import path from "node:path";

export const pushPaths = (repoDir) => ({
  request: path.join(repoDir, ".git", "push-request"),
  status: path.join(repoDir, ".push", "status.json"),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** {head, ok, at, message} from the host pusher, or null if it never ran. */
export function readPushStatus(repoDir) {
  try {
    return JSON.parse(fs.readFileSync(pushPaths(repoDir).status, "utf8"));
  } catch {
    return null;
  }
}

export function requestPush(repoDir, head) {
  fs.writeFileSync(pushPaths(repoDir).request, `${head} ${new Date().toISOString()}\n`);
}

/**
 * Ask the host to push `head` and wait for its answer.
 * @returns {Promise<{state: "done"|"fail"|"warn", detail: string}>}
 */
export async function pushAndWait(repoDir, head, { timeoutMs = 90_000, pollMs = 1000, retryMs = 20_000, onWait } = {}) {
  if (!fs.existsSync(path.dirname(pushPaths(repoDir).status))) {
    return { state: "skip", detail: "push service not installed (scripts/push/install.sh)" };
  }
  const started = Date.now();
  let lastRequest = 0;
  for (;;) {
    const now = Date.now();
    // re-request now and then: a request written while the service is already running can be missed
    if (now - lastRequest >= retryMs) {
      requestPush(repoDir, head);
      lastRequest = now;
    }
    const s = readPushStatus(repoDir);
    if (s && s.head === head && Date.parse(s.at) >= started - 1000) {
      return s.ok
        ? { state: "done", detail: `${s.message || "pushed"} · ${head.slice(0, 7)}` }
        : { state: "fail", detail: s.message || "push failed" };
    }
    if (now - started > timeoutMs) {
      return { state: "warn", detail: "no answer from the push service yet (try /fd_status later)" };
    }
    onWait?.(Math.round((now - started) / 1000));
    await sleep(pollMs);
  }
}

/** One line for /fd_status. */
export function pushStatusLine(repoDir, head) {
  const s = readPushStatus(repoDir);
  if (!s) return "⬆️ GitHub: push service never ran";
  const when = String(s.at ?? "").replace("T", " ").slice(0, 16);
  if (!s.ok) return `⬆️ GitHub: ❌ last push failed ${when} UTC — ${s.message}`;
  return `⬆️ GitHub: ${s.head === head ? "up to date" : "behind (next /fd_sync pushes)"} · last push ${when} UTC (${String(s.head).slice(0, 7)})`;
}
