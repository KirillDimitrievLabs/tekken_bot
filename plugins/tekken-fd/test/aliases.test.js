import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AliasStore, parseAliasReply } from "../src/aliases.js";

const ROSTER = ["Devil Jin", "Fahkumram", "Jin", "Kazuya"];

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-alias-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "curated.json"), JSON.stringify({ fahk: "Fahkumram", dvj: "Devil Jin" }));
  const store = new AliasStore({ curatedPath: path.join(dir, "curated.json"), addedPath: path.join(dir, "data", "aliases.json"), repoDir: dir });
  return { dir, git, store };
}

test("reply parsing: bare name, separators, trailing name, errors", () => {
  const { store } = tempRepo();
  assert.deepEqual(parseAliasReply("Fahkumram", "fahkie", store, ROSTER), { alias: "fahkie", character: "Fahkumram" });
  assert.deepEqual(parseAliasReply("fahk", "fahkie", store, ROSTER), { alias: "fahkie", character: "Fahkumram" });
  assert.deepEqual(parseAliasReply("dj2 = Devil Jin", "x", store, ROSTER), { alias: "dj2", character: "Devil Jin" });
  assert.deepEqual(parseAliasReply("mishima kid -> Kazuya", "x", store, ROSTER), { alias: "mishima kid", character: "Kazuya" });
  assert.deepEqual(parseAliasReply("kazzy Kazuya", "x", store, ROSTER), { alias: "kazzy", character: "Kazuya" });
  assert.ok(parseAliasReply("Kazuyaa", "x", store, ROSTER).error); // no fuzzy for admin input
});

test("add writes data/aliases.json, commits, and is picked up", async () => {
  const { git, store } = tempRepo();
  git("commit", "-q", "--allow-empty", "-m", "init");
  const r = await store.add("Fahkie", "Fahkumram", ROSTER, { by: "telegram:1" });
  assert.equal(r.alias, "fahkie");
  assert.equal(store.all().fahkie, "Fahkumram");
  assert.match(git("log", "-1", "--format=%s"), /^aliases: fahkie → Fahkumram$/);
  await assert.rejects(store.add("jin", "Kazuya", ROSTER), /already the name of Jin/);
});
