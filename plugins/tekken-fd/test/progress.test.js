import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { counter, ProgressBoard, reportText, SYNC_STEPS } from "../src/progress.js";
import { pushAndWait, pushPaths, pushStatusLine } from "../src/push.js";

test("progress board renders every step and throttles running updates", async () => {
  let t = 0;
  const shown = [];
  const board = new ProgressBoard("🔄 Sync", SYNC_STEPS, { show: async (x) => shown.push(x), minIntervalMs: 1000, now: () => t });
  await board.flush(true);
  board.update("moves", "run", "500 rows");
  board.update("moves", "run", "1000 rows"); // throttled, shown later
  assert.equal(shown.length, 1);
  t = 3000;
  await board.update("moves", "done", "9000 moves, 42 characters");
  board.update("punishers", "run", counter({ done: 3, total: 42, character: "Kazuya" }));
  t = 5000;
  await board.update("punishers", "warn", reportText({ ok: 30, missing: ["A", "B"], errors: ["Kuma"] }));
  board.skipRest("dry run");
  await board.finish("✅ Done.");
  const last = shown.at(-1);
  assert.match(last, /^🔄 Sync · 5s/);
  assert.match(last, /✅ Wavu frame data — 9000 moves, 42 characters/);
  assert.match(last, /⚠️ Wavu punishers — 30 characters, 2 without a page, failed: Kuma/);
  assert.match(last, /➖ GitHub push — dry run/);
  assert.match(last, /✅ Done\.$/);
});

test("push hand-off: request file, then wait for the host's status", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fd-push-"));
  fs.mkdirSync(path.join(repo, ".git"));
  fs.mkdirSync(path.join(repo, ".push"));
  const head = "a".repeat(40);
  const host = setTimeout(() => {
    assert.match(fs.readFileSync(pushPaths(repo).request, "utf8"), new RegExp(`^${head} `));
    fs.writeFileSync(pushPaths(repo).status, JSON.stringify({ ok: true, head, at: new Date().toISOString(), message: "pushed" }));
  }, 50);
  const r = await pushAndWait(repo, head, { pollMs: 20, timeoutMs: 2000 });
  clearTimeout(host);
  assert.deepEqual(r, { state: "done", detail: "pushed · aaaaaaa" });
  assert.match(pushStatusLine(repo, head), /GitHub: up to date/);

  fs.writeFileSync(pushPaths(repo).status, JSON.stringify({ ok: false, head: "b".repeat(40), at: new Date().toISOString(), message: "rejected" }));
  assert.match(pushStatusLine(repo, head), /❌ last push failed .* rejected/);
  const late = await pushAndWait(repo, head, { pollMs: 20, timeoutMs: 100 });
  assert.equal(late.state, "warn");
  fs.rmSync(path.join(repo, ".push"), { recursive: true });
  assert.equal((await pushAndWait(repo, head)).state, "skip");
  fs.rmSync(repo, { recursive: true, force: true });
});
