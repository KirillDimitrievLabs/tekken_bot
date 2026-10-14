import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { buildDatabase, MoveIndex } from "../src/db.js";
import { resolveCharacter, resolveMove } from "../src/resolve.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/Fahkumram.json", import.meta.url), "utf8"));
const aliases = JSON.parse(fs.readFileSync(new URL("../aliases.json", import.meta.url), "utf8"));
const ROSTER = ["Devil Jin", "Fahkumram", "Jack-8", "Jin", "Jun", "Kazuya", "Lee", "Leo", "Leroy"];
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

test("characters: exact, nickname, prefix, typo", () => {
  assert.equal(resolveCharacter("Fahkumram", ROSTER, aliases).match, "Fahkumram");
  assert.equal(resolveCharacter("fahk", ROSTER, aliases).match, "Fahkumram");
  assert.equal(resolveCharacter("dvj", ROSTER, aliases).match, "Devil Jin");
  assert.equal(resolveCharacter("jack8", ROSTER, aliases).match, "Jack-8");
  assert.equal(resolveCharacter("kazuyaa", ROSTER, aliases).match, "Kazuya");
  assert.equal(resolveCharacter("le", ROSTER, aliases).match, null); // Lee/Leo/Leroy: ambiguous
});

test("moves: notation variants resolve to the same id", () => {
  for (const q of ["3,1,2", "312", "3 1 2", "Ayutthaya Piercing Thunder"]) {
    const r = resolveMove(index, "Fahkumram", q);
    assert.equal(r.status, "match", q);
    assert.equal(r.move.id, "Fahkumram-3,1,2", q);
  }
  assert.equal(resolveMove(index, "Fahkumram", "df1").move.id, "Fahkumram-df+1");
});

test("moves: miss returns candidates, not a guess", () => {
  const r = resolveMove(index, "Fahkumram", "3,1,3");
  assert.notEqual(r.status, "match");
  assert.ok(r.candidates.some((c) => c.id === "Fahkumram-3,1,2"));
});

test("chain walks parents root → move", () => {
  assert.deepEqual(index.chain("Fahkumram-3,1,2").map((m) => m.id), ["Fahkumram-3", "Fahkumram-3,1", "Fahkumram-3,1,2"]);
});

test("alias dotlist and entity names are cleaned in the index", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tekken-fd-"));
  const moves = [
    { id: "Paul-qcf", num: "1", name: "Cormorant Step", input: "qcf", parent: null,
      alias: "&lt;div class=&quot;dotlist&quot;&gt;\n\n* CS\n* qcf\n&lt;/div&gt;", alt: null },
    { id: "Paul-df+1+3,qcf+2", num: "2", name: "Kongo Blast &gt; Phoenix Smasher", input: ",qcf+2", parent: null, alias: null, alt: null },
    { id: "Law-db+4", num: "3", name: "Dragon&#039;s Tail", input: "db+4", parent: null, alias: null, alt: null },
  ];
  buildDatabase(path.join(d, "x.sqlite"), new Map([["Paul", moves.slice(0, 2)], ["Law", moves.slice(2)]]));
  const ix = new MoveIndex(path.join(d, "x.sqlite"));
  try {
    assert.equal(resolveMove(ix, "Paul", "cs").move.id, "Paul-qcf");
    const qcf2 = resolveMove(ix, "Paul", "qcf2");
    assert.equal(qcf2.status, "ambiguous");
    assert.equal(qcf2.candidates[0].id, "Paul-df+1+3,qcf+2");
    assert.equal(resolveMove(ix, "Law", "Dragon's Tail").move.id, "Law-db+4");
    assert.ok(resolveMove(ix, "Law", "dragon tail").candidates.some((m) => m.id === "Law-db+4"));
  } finally {
    ix.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
