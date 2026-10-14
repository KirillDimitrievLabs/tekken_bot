import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { buildDatabase, MoveIndex } from "../src/db.js";
import { fastResolve, parseTrigger, splitQuery } from "../src/fastpath.js";

const aliases = JSON.parse(fs.readFileSync(new URL("../aliases.json", import.meta.url), "utf8"));
const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/Fahkumram.json", import.meta.url), "utf8"));
const ROSTER = ["Armor King", "Devil Jin", "Fahkumram", "Jin", "King", "Lee"];
let dir, index;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tekken-fd-"));
  buildDatabase(path.join(dir, "t8.sqlite"), new Map([["Fahkumram", fx.moves]]));
  index = new MoveIndex(path.join(dir, "t8.sqlite"));
});
after(() => {
  index.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("trigger parsing", () => {
  assert.equal(parseTrigger("!fd Fahkumram 312"), "Fahkumram 312");
  assert.equal(parseTrigger("  !FD  devil   jin ws2 "), "devil jin ws2");
  assert.equal(parseTrigger("@tekken_frames_bot !fd kaz df1"), "kaz df1");
  assert.equal(parseTrigger("what is !fd"), null);
  assert.equal(parseTrigger("!fdx"), null);
});

test("character split prefers multi-word names, never eats the move", () => {
  assert.deepEqual(splitQuery("devil jin ws2", ROSTER, aliases), { character: "Devil Jin", move: "ws2" });
  assert.deepEqual(splitQuery("armor king df+1", ROSTER, aliases), { character: "Armor King", move: "df+1" });
  assert.deepEqual(splitQuery("jin 1", ROSTER, aliases), { character: "Jin", move: "1" });
  assert.deepEqual(splitQuery("fahk 3 1 2", ROSTER, aliases), { character: "Fahkumram", move: "3 1 2" });
  assert.equal(splitQuery("fahk", ROSTER, aliases), null);
});

test("exact queries resolve, vague ones defer to the model", () => {
  assert.equal(fastResolve(index, "!fd Fahkumram 312", aliases).move.id, "Fahkumram-3,1,2");
  assert.equal(fastResolve(index, "!fd fahk df1", aliases).move.id, "Fahkumram-df+1");
  assert.equal(fastResolve(index, "!fd fahk knee", aliases), null);
  assert.equal(fastResolve(index, "!fd fahk 3,1,3", aliases), null);
  assert.equal(fastResolve(index, "hello", aliases), null);
});

test("deterministic suggestions for non-reasoning sessions", async () => {
  const { suggestReply } = await import("../src/fastpath.js");
  assert.equal(suggestReply(index, "hello", aliases), null);
  assert.match(suggestReply(index, "!fd", aliases), /^Usage/);
  assert.match(suggestReply(index, "!fd fahk 3,1,3", aliases), /Did you mean: .*3,1,2/);
  assert.match(suggestReply(index, "!fd fahk", aliases), /Which Fahkumram move/);
});
