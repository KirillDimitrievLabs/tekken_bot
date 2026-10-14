import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoachCache, cacheKey } from "../src/coach/cache.js";
import { Coach } from "../src/coach/index.js";

const validGuide = () => ({
  summary: "Punish committed threats at the spacing you tested.", key_threats: [], defense: [], punish: [], lows: [],
  their_turn: "Respect pressure where the dossier has no escape evidence.", neutral: "Test the spacing before committing.",
  heat_and_wall: "Heat and wall evidence is missing.", common_mistakes: ["Committing without checking spacing."],
  lab_drill: ["Record the cited threats and practice the supported answers."], confidence: "medium", gaps: ["Reach requires practice verification."],
  used_tips: [], used_guides: [],
});

function temp(t, close = async () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coach-runtime-"));
  t.after(async () => {
    await close();
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith("coach-runtime-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

function subject(t, complete, opts = {}) {
  let coach;
  const root = temp(t, () => coach.close());
  const index = { move: () => null };
  coach = new Coach({ index, repoDir: path.join(root, "repo"), stateDir: path.join(root, "state"), complete, ...opts });
  const versions = { data: "data-v1", tips: "tips-v1" };
  coach.dossier = (target) => ({
    mode: "counter", as: null, opponent: target.opponent, language: target.language ?? "en", level: target.level ?? "mid",
    hash: `${target.opponent}:${versions.data}`, tipsHash: versions.tips, text: "No actionable escape facts in this synthetic fixture.",
    moves: new Map(), requiredUnsafe: [], escapeAnswers: [], interactions: {}, coverage: { level: "ok" }, guideIds: [], tipIds: [], tips: [], sources: [], dataVersion: versions.data,
  });
  return { coach, versions, target: { as: null, opponent: "Reina", language: "en", level: "mid" } };
}

test("cache keys include each source/prompt/model/user-facing dimension", () => {
  const input = { mode: "matchup", as: "Kazuya", opponent: "Reina", language: "en", level: "mid", dossierHash: "d", tipsHash: "t", promptVersion: "p", model: "openai/gpt-6.1-sol" };
  const original = cacheKey(input);
  for (const field of Object.keys(input)) assert.notEqual(cacheKey({ ...input, [field]: `${input[field]}-different` }), original, field);
  assert.equal(cacheKey({ ...input }), original);
});

test("cache persists hits and guide metadata; character invalidation removes either side", (t) => {
  let cache;
  cache = new CoachCache(path.join(temp(t, () => cache.close()), "coach.sqlite"));
  for (const [key, as, opponent] of [["forward", "Kazuya", "Reina"], ["reverse", "Reina", "Jin"], ["other", "Jin", "King"]]) cache.put(key, { guide: validGuide(), parts: ["<b>Guide</b>"], model: "openai/gpt-6.1-sol", as, opponent });
  assert.equal(cache.get("forward").model, "openai/gpt-6.1-sol");
  assert.equal(cache.get("forward", { count: false }).hits, 1);
  cache.invalidate("Reina");
  assert.equal(cache.get("forward"), null);
  assert.equal(cache.get("reverse"), null);
  assert.ok(cache.get("other"));
  cache.invalidate();
  assert.equal(cache.stats().guides, 0);
});

test("private daily limits persist, isolate users and reset on the UTC day", (t) => {
  let now = Date.parse("2026-10-14T23:59:59Z");
  let cache;
  const file = path.join(temp(t, () => cache.close()), "coach.sqlite");
  cache = new CoachCache(file, { now: () => now });
  for (let i = 0; i < 5; i++) assert.equal(cache.consume("user-a"), true);
  assert.equal(cache.consume("user-a"), false);
  assert.equal(cache.consume("user-b"), true);
  cache.close();
  cache = new CoachCache(file, { now: () => now });
  assert.equal(cache.consume("user-a"), false);
  now += 1000;
  assert.equal(cache.consume("user-a"), true);
  assert.equal(cache.preference("user-a").language, "en");
  assert.deepEqual(cache.setPreference("user-a", { language: "ru", level: "high" }), { language: "ru", level: "high" });
  assert.throws(() => cache.setPreference("user-a", { language: "de" }));
});

test("a cached guide avoids another completion and data/tip/prompt-sensitive keys refresh it", async (t) => {
  let calls = 0;
  const { coach, versions, target } = subject(t, async () => { calls++; return { text: JSON.stringify(validGuide()) }; });
  const first = await coach.generate(target, { userId: "user-a" });
  assert.equal(first.fallback, undefined);
  const cached = await coach.generate(target, { userId: "user-a" });
  assert.equal(cached.cached, true);
  assert.equal(calls, 1);
  versions.data = "data-v2";
  const freshData = await coach.generate(target, { userId: "user-a" });
  assert.notEqual(freshData.key, first.key);
  versions.tips = "tips-v2";
  const freshTips = await coach.generate(target, { userId: "user-a" });
  assert.notEqual(freshTips.key, freshData.key);
  assert.equal(calls, 3);
});

test("duplicate in-flight requests share a completion and charge only the generating user", async (t) => {
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  let calls = 0;
  const { coach, target } = subject(t, async () => { calls++; await gate; return { text: JSON.stringify(validGuide()) }; });
  const first = coach.generate(target, { userId: "user-a" });
  const duplicate = coach.generate(target, { userId: "user-b" });
  unblock();
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(a.key, b.key);
  assert.equal(calls, 1);
  for (let i = 0; i < 4; i++) assert.equal(coach.cache.consume("user-a"), true);
  assert.equal(coach.cache.consume("user-a"), false);
  for (let i = 0; i < 5; i++) assert.equal(coach.cache.consume("user-b"), true);
  assert.equal(coach.cache.consume("user-b"), false);
});

test("global generation concurrency is capped and queued jobs finish", async (t) => {
  let resolveStarted;
  const startedTwo = new Promise((resolve) => { resolveStarted = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0, peak = 0, calls = 0;
  const { coach, target } = subject(t, async () => {
    calls++; active++; peak = Math.max(peak, active);
    if (calls === 2) resolveStarted();
    await gate;
    active--;
    return { text: JSON.stringify(validGuide()) };
  });
  const jobs = ["Reina", "Jin", "Kazuya", "King"].map((opponent) => coach.generate({ ...target, opponent }, { userId: "user-a" }));
  await startedTwo;
  assert.equal(calls, 2);
  assert.equal(coach.active, 2);
  release();
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => !r.fallback));
  assert.equal(calls, 4);
  assert.equal(peak, 2);
  assert.equal(coach.active, 0);
  assert.equal(coach.pending.size, 0);
});

test("language variants serialize for one pair while a different pair occupies another slot", async (t) => {
  const starts = [], overlappingPairs = [];
  const running = new Set();
  const gates = new Map();
  let secondStarted, thirdStarted;
  const firstBatch = new Promise((resolve) => { secondStarted = resolve; });
  const variantStarted = new Promise((resolve) => { thirdStarted = resolve; });
  let peak = 0;
  const { coach, target } = subject(t, async (input) => {
    const opponent = input.messages[0].content.match(/counter-guide for fighting (\S+) /)?.[1];
    const language = input.systemPrompt.includes("Пиши по-русски") ? "ru" : "en";
    const label = `${opponent}:${language}`;
    if (running.has(opponent)) overlappingPairs.push(label);
    running.add(opponent);
    peak = Math.max(peak, running.size);
    const gate = new Promise((resolve) => { gates.set(label, resolve); });
    starts.push(label);
    if (starts.length === 2) secondStarted();
    if (starts.length === 3) thirdStarted();
    await gate;
    running.delete(opponent);
    return { text: JSON.stringify(validGuide()) };
  });
  const jobs = [
    coach.generate(target, { userId: "user-a" }),
    coach.generate({ ...target, language: "ru" }, { userId: "user-a" }),
    coach.generate({ ...target, opponent: "Jin" }, { userId: "user-a" }),
  ];
  await firstBatch;
  assert.deepEqual(new Set(starts), new Set(["Reina:en", "Jin:en"]));
  assert.equal(coach.active, 2);
  gates.get("Reina:en")();
  await variantStarted;
  assert.equal(starts.at(-1), "Reina:ru");
  assert.equal(coach.active, 2);
  gates.get("Reina:ru")();
  gates.get("Jin:en")();
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => !r.fallback));
  assert.deepEqual(results.map((r) => r.dossier.language), ["en", "ru", "en"]);
  assert.deepEqual(overlappingPairs, []);
  assert.equal(peak, 2);
  assert.equal(coach.resources.size, 0);
  assert.equal(coach.active, 0);
});

test("corrective retry includes actionable validation errors; repeated errors use fallback", async (t) => {
  const inputs = [];
  const { coach, target } = subject(t, async (input) => {
    inputs.push(input);
    const guide = validGuide();
    if (inputs.length === 1) guide.summary = "A made-up claim of 99 damage.";
    return { text: JSON.stringify(guide) };
  });
  const result = await coach.generate(target, { userId: "user-a" });
  assert.equal(result.fallback, undefined);
  assert.equal(inputs.length, 2);
  assert.match(inputs[1].messages[0].content, /numeric prose is forbidden/);
  assert.equal(inputs[0].model, "openai/gpt-6.1-sol");
  assert.equal(inputs[0].reasoning, "high");
  assert.equal(inputs[0].execution.mode, "isolated-agent-runtime");
  assert.equal(inputs[0].execution.timeoutMs, 180000);
  coach.complete = async () => ({ text: '{"summary":"made-up 99"}' });
  const fallback = await coach.generate({ ...target, opponent: "Jin" }, { userId: "user-a" });
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.key, null);
  assert.equal(coach.cache.stats().guides, 1);
});

test("completion failures and missing runtime return facts; no stale result is cached after a source change", async (t) => {
  const { coach, versions, target } = subject(t, null);
  assert.equal((await coach.generate(target, { userId: "user-a" })).fallback, true);
  coach.complete = async () => { throw new Error("Provider failed"); };
  assert.equal((await coach.generate(target, { userId: "user-a" })).fallback, true);
  coach.complete = async () => { versions.data = "data-v2"; return { text: JSON.stringify(validGuide()) }; };
  const changed = await coach.generate(target, { userId: "user-a" });
  assert.equal(changed.fallback, true);
  assert.match(changed.reason, /Data changed/);
  assert.equal(coach.cache.stats().guides, 0);
});

test("admin regeneration overrides cache while ordinary users cannot force or select a model", async (t) => {
  let calls = 0;
  const { coach, target } = subject(t, async () => { calls++; return { text: JSON.stringify(validGuide()) }; });
  await coach.generate(target, { userId: "user-a" });
  await assert.rejects(coach.generate(target, { userId: "user-a", force: true }), /admin/);
  await assert.rejects(coach.generate(target, { userId: "user-a", modelOverride: "openai/gpt-6-astra" }), /Owner-only/);
  await coach.generate(target, { userId: "admin", admin: true, force: true });
  assert.equal(calls, 2);
  await coach.close();
  await assert.rejects(coach.generate(target, { userId: "user-a" }), /stopping/);
  // Replace teardown: close has already completed, and DatabaseSync.close is not idempotent.
  coach.close = async () => {};
});

test("failed forced regeneration deletes the old cached guide and ordinary requests can rebuild it", async (t) => {
  let calls = 0;
  const { coach, target } = subject(t, async () => { calls++; return { text: JSON.stringify(validGuide()) }; });
  const first = await coach.generate(target, { userId: "user-a" });
  assert.ok(coach.cache.get(first.key, { count: false }));
  coach.complete = async () => { calls++; throw new Error("Provider unavailable"); };
  const failed = await coach.generate(target, { userId: "admin", admin: true, force: true });
  assert.equal(failed.fallback, true);
  assert.equal(coach.cache.get(first.key, { count: false }), null);
  coach.complete = async () => { calls++; return { text: JSON.stringify(validGuide()) }; };
  const recovered = await coach.generate(target, { userId: "user-a" });
  assert.equal(recovered.cached, false);
  assert.equal(recovered.key, first.key);
  assert.equal(calls, 3);
});
