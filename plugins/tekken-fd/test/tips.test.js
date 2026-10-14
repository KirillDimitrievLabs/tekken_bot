import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inferTipCategory, resolveTipMoves, Tips, tipSimilarity } from "../src/tips.js";
import { looseKey, strictKey } from "../src/notation.js";

const moves = [
  { id: "Reina-b+4", character: "Reina", key: "b+4", startup: "15", block: "-13", hit: "+25a" },
  { id: "Reina-1,2,1", character: "Reina", key: "1,2,1", startup: "10", block: "-14", hit: "+5" },
  { id: "Reina-df+2", character: "Reina", key: "df+2", startup: "15", block: "-12", hit: "+30a" },
  { id: "Kazuya-b+4", character: "Kazuya", key: "b+4", startup: "17", block: "-9", hit: "+14" },
  { id: "Kazuya-1,1,2", character: "Kazuya", key: "1,1,2", startup: "10", block: "-17", hit: "+20d" },
  { id: "Reina-1", character: "Reina", key: "1", startup: "10", block: "+1", hit: "+8" },
];
const index = {
  characters: () => [{ name: "Reina" }, { name: "Kazuya" }],
  meta: () => ({ fetchedAt: "2026-10-14T08:00:00Z" }),
  move: (id) => moves.find((move) => move.id === id) ?? null,
  byKey: (character, kind, value) => moves.filter((move) => move.character === character && (kind === "strict" ? strictKey(move.key) : looseKey(move.key)) === value),
};

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-tips-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repoDir = path.join(dir, "repo"), stateDir = path.join(dir, "state");
  fs.mkdirSync(repoDir);
  const changes = [], commits = [];
  const tips = new Tips({ repoDir, stateDir, index, commit: async (request) => { commits.push(request); return "tipcommit"; }, onChange: (change) => changes.push(change), ...options });
  const submit = (text = "Duck the 3rd hit of 1,2,1, then launch.", extra = {}) => {
    const draft = tips.draft({ userId: "123456789", author: "Alex", opponent: "Reina", text, ...extra });
    return tips.confirm(draft.id, extra.userId ?? "123456789");
  };
  return { dir, repoDir, stateDir, tips, submit, changes, commits };
}

test("notation resolution validates ids, reports ambiguity, and leaves counts literal", () => {
  const parsed = resolveTipMoves(index, "Duck the 3rd hit of 1,2,1 after 2 hits; punish b+4.", { opponent: "Reina" });
  assert.equal(parsed.text, "Duck the 3rd hit of [[Reina-1,2,1]] after 2 hits; punish [[Reina-b+4]].");
  assert.deepEqual(parsed.moves, ["Reina-1,2,1", "Reina-b+4"]);
  assert.equal(parsed.detected[1].block, "-13");
  const ambiguity = resolveTipMoves(index, "Use b+4, then Kazuya 1,1,2.", { as: "Kazuya", opponent: "Reina" });
  assert.match(ambiguity.text, /^Use b\+4/);
  assert.equal(ambiguity.unresolved[0].candidates.length, 2);
  assert.match(ambiguity.text, /\[\[Kazuya-1,1,2\]\]/);
  assert.equal(resolveTipMoves(index, "Reina b+4 is unsafe.", { as: "Kazuya", opponent: "Reina" }).moves[0], "Reina-b+4");
  assert.throws(() => resolveTipMoves(index, "[[Jin-df+2]]", { opponent: "Reina" }), /Unknown or wrong-character/);
  assert.throws(() => resolveTipMoves(index, "[[Reina-b+4", { opponent: "Reina" }), /complete/);
});

test("submission needs author confirmation; moderation publishes display names without private identities", async (t) => {
  const { tips, commits, changes } = setup(t);
  const draft = tips.draft({ userId: "123456789", author: "Alex", opponent: "Reina", text: "Duck the 3rd hit of 1,2,1, then launch." });
  assert.equal(draft.status, "draft"); assert.equal(tips.queue().length, 0);
  assert.throws(() => tips.confirm(draft.id, "999"), /another user/);
  await assert.rejects(tips.approve(draft.id), /Only queued/);
  const pending = tips.confirm(draft.id, "123456789");
  assert.equal(pending.status, "pending"); assert.equal(pending.category, "defense");
  assert.equal(tips.queue()[0].id, draft.id);
  const approved = await tips.approve(draft.id);
  assert.equal(approved.commit, "tipcommit"); assert.equal(tips.queue().length, 0);
  const publicRecords = JSON.parse(fs.readFileSync(tips.file, "utf8"));
  assert.equal(publicRecords[0].author, "Alex");
  assert.equal(publicRecords[0].text, "Duck the 3rd hit of [[Reina-1,2,1]], then launch.");
  assert.equal(publicRecords[0].userId, undefined);
  assert.doesNotMatch(JSON.stringify(publicRecords), /123456789|rawText|detected|unresolved|votes/);
  assert.equal(tips.own("123456789")[0].status, "approved");
  assert.equal(commits[0].relativePath, "data/tips/t8-tips.json");
  assert.equal(changes[0].reason, "approved");
  assert.doesNotMatch(JSON.stringify(tips.approved(null, "Reina")), /123456789/);
});

test("length, character, draft caps and trigram duplicate checks prevent repeated submissions", (t) => {
  const { tips, submit } = setup(t);
  assert.throws(() => tips.draft({ userId: "1", opponent: "Reina", text: "Short" }), /20–400/);
  assert.throws(() => tips.draft({ userId: "1", opponent: "Reina", text: "a".repeat(401) }), /20–400/);
  assert.throws(() => tips.draft({ userId: "1", opponent: "Jin", text: "A long enough tip about an unknown opponent" }), /Unknown character/);
  const first = submit();
  assert.throws(() => submit("Duck the 3rd hit of 1,2,1, then launch!", { userId: "2" }), /existing tip/);
  assert(tipSimilarity("A concrete repeatable setup", "A concrete repeatable setup!") > 0.8);
  const texts = [
    "Block patiently near the corner and watch for heat.", "Use long range keepout buttons to stop approaches.",
    "Practice a crouching response to the string mixup.", "Fast mids cover their evasive stance transitions.",
  ];
  for (const text of texts) tips.draft({ userId: "123456789", opponent: "Reina", text });
  assert.throws(() => tips.draft({ userId: "123456789", opponent: "Reina", text: "Record a safe jab check after their pressure." }), /5 pending/);
  assert.equal(first.status, "pending");
});

test("category and edits are moderated; rejected tips stay private and explain their status", async (t) => {
  const { tips, submit } = setup(t);
  const tip = submit("At the wall respect Reina b+4 and crouch carefully.");
  assert.equal(tip.category, "wall");
  await tips.setCategory(tip.id, "#defense");
  await tips.edit(tip.id, "Block Reina df+2, then use your best standing punish.");
  assert.equal(tips.get(tip.id).moves[0], "Reina-df+2");
  await tips.approve(tip.id);
  const before = tips.hash(null, "Reina");
  await tips.edit(tip.id, "Block Reina b+4, then use your best standing punish.");
  assert.notEqual(tips.hash(null, "Reina"), before);
  assert.equal(tips.approved(null, "Reina")[0].moves[0], "Reina-b+4");
  const another = submit("Backdash to bait approaches and whiff punish with a mid.", { userId: "2", author: "2" });
  await assert.rejects(tips.reject(another.id, ""), /Rejection reason/);
  await tips.reject(another.id, "Please give a specific situation and move.");
  assert.equal(tips.own("2")[0].rejectionReason, "Please give a specific situation and move.");
  assert.equal(tips.own("2")[0].author, "Clan member");
  assert.equal(tips.approved(null, "Reina").length, 1);
  assert.equal(tips.queue().length, 0);
  assert.equal(inferTipCategory("Whiff punish from range"), "punish");
});

test("votes are unique and negative review persists across restart without leaking voter ids", async (t) => {
  const { tips, submit, repoDir, stateDir } = setup(t);
  const tip = submit(); await tips.approve(tip.id);
  const initialHash = tips.hash(null, "Reina");
  await tips.vote(tip.id, "800000001", -1);
  await assert.rejects(tips.vote(tip.id, "800000001", 1), /already voted/);
  await tips.vote(tip.id, "800000002", -1);
  const result = await tips.vote(tip.id, "800000003", -1);
  assert.equal(result.votes, -3); assert.equal(result.needsReview, true);
  const restart = new Tips({ repoDir, stateDir, index, commit: false });
  assert.equal(restart.queue()[0].status, "needsReview");
  assert.equal(restart.approved(null, "Reina")[0].needsReview, true);
  assert.notEqual(restart.hash(null, "Reina"), initialHash);
  assert.doesNotMatch(fs.readFileSync(tips.file, "utf8"), /80000000|123456789/);
  await restart.approve(tip.id);
  assert.equal(restart.approved(null, "Reina")[0].votes, 0);
  assert.equal(restart.approved(null, "Reina")[0].needsReview, undefined);
  await restart.vote(tip.id, "800000001", 1);
  assert.equal(restart.approved(null, "Reina")[0].votes, 1);
});

test("frame changes flag referenced tips, skip damage-only edits, and rejection removes publication", async (t) => {
  const { tips, submit } = setup(t);
  const tip = submit(); await tips.approve(tip.id);
  const hash = tips.hash(null, "Reina");
  assert.equal((await tips.flagChangedMoves({ changes: [{ character: "Reina", key: "1,2,1", field: "damage", from: "10", to: "12" }] })).length, 0);
  assert.equal(tips.hash(null, "Reina"), hash);
  const flagged = await tips.flagChangedMoves({ changes: [{ character: "Reina", key: "1,2,1", field: "block", from: "-14", to: "-10" }], removed: {} });
  assert.equal(flagged[0].id, tip.id);
  assert.match(tips.queue()[0].reviewReason, /block: -14 → -10/);
  assert.notEqual(tips.hash(null, "Reina"), hash);
  await tips.reject(tip.id, "Patch invalidated this response.");
  assert.equal(tips.approved(null, "Reina").length, 0);
  assert.equal(tips.own("123456789")[0].status, "rejected");
});

test("specific matchup retrieval includes general knowledge, with only matching tips affecting hash", async (t) => {
  const { tips, submit } = setup(t);
  await tips.approve(submit().id);
  const generalHash = tips.hash(null, "Reina");
  await tips.approve(submit("Use Kazuya 1,1,2 after blocking Reina b+4.", { as: "Kazuya" }).id);
  assert.equal(tips.approved(null, "Reina").length, 1);
  assert.equal(tips.approved("Kazuya", "Reina").length, 2);
  assert.equal(tips.approved({ as: "Kazuya", opponent: "Reina" }).length, 2);
  assert.equal(tips.hash(null, "Reina"), generalHash);
  assert.equal(tips.approved("Kazuya", "Kazuya").length, 0);
});

test("private state cannot be kept in git, corrupt state fails closed, and failed approval remains pending", async (t) => {
  const { tips, submit, repoDir } = setup(t, { commit: async () => { throw new Error("git unavailable"); } });
  assert.throws(() => new Tips({ repoDir, stateDir: path.join(repoDir, "state"), index }), /outside/);
  const tip = submit();
  await assert.rejects(tips.approve(tip.id), /commit failed/);
  assert.equal(tips.get(tip.id).status, "pending");
  assert.deepEqual(JSON.parse(fs.readFileSync(tips.file, "utf8")), []);
  fs.writeFileSync(tips.stateFile, "{bad json");
  assert.throws(() => tips.queue(), /Cannot read tips storage/);
});

test("default moderation commit includes only the tips path despite other staged work", async (t) => {
  const { tips, submit, repoDir } = setup(t, { commit: undefined });
  const git = (...args) => execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" }).toString().trim();
  git("init", "-q"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repoDir, "unrelated.txt"), "before\n");
  git("add", "--", "unrelated.txt"); git("commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(repoDir, "unrelated.txt"), "after\n"); git("add", "--", "unrelated.txt");
  await tips.approve(submit().id);
  assert.equal(git("show", "--format=", "--name-only", "HEAD"), "data/tips/t8-tips.json");
  assert.match(git("diff", "--cached", "--name-only"), /unrelated.txt/);
});
