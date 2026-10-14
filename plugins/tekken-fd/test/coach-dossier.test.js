import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildDatabase, MoveIndex } from "../src/db.js";
import { buildDossier, DOSSIER_LIMITS } from "../src/coach/dossier.js";
import { parseGuide } from "../src/guides.js";

function fixture(t, change = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coach-dossier-"));
  const rows = new Map(["A", "B"].map((character) => [character, [
    { id: `${character}-1`, num: 1, startup: "i10", block: "+1", hit: "+8", target: "h", damage: "10" },
    { id: `${character}-df+1`, num: 2, startup: "i13", block: "-3", hit: "+7", target: "m", damage: "15", ...change },
    { id: `${character}-df+2`, num: 3, startup: "i15", block: "-12", hit: "+67a", target: "m", damage: "20" },
    { id: `${character}-ws4`, num: 4, startup: "i11", block: "-6", hit: "+7", target: "m", damage: "17" },
    { id: `${character}-ws2`, num: 5, startup: "i15", block: "-13", hit: "+60a", target: "m", damage: "20" },
    { id: `${character}-d+3`, num: 6, startup: "i18", block: "-13", hit: "+3", target: "l", damage: "17", crush: "cs6~15" },
    { id: `${character}-d+4`, num: 7, startup: "i20", block: "-16", hit: "+6", target: "l", damage: "20" },
    { id: `${character}-db+4`, num: 8, startup: "i19", block: "-15", hit: "+43d", target: "l", damage: "23" },
    { id: `${character}-b+4`, num: 9, startup: "i20", block: "-20", hit: "+60a", target: "m", damage: "25", notes: "* Homing\n* Heat engager\n* Heat Dash +5, +43d (+35)\n* Wall splat" },
    { id: `${character}-uf+4`, num: 10, startup: "i15", block: "-13", hit: "+60a", target: "m", damage: "20", crush: "js9~20" },
    { id: `${character}-1,2`, parent: `${character}-1`, num: 11, startup: "i18", block: "-12", hit: "+5", target: "h", damage: "15", notes: "* Interrupt with i12 from 1st block\n* Whiffs vs SSR from 1st block\n* Combo from 1st CH" },
    { id: `${character}-1+2`, num: 12, startup: "i20", block: "-12", hit: "+43d", target: "m", damage: "25", crush: "pc8~20" },
    { id: `${character}-df+1+3`, num: 13, startup: "i12", block: "!", hit: "+43d", target: "t", damage: "35", notes: "* Throw break: 1+2" },
    { id: `${character}-b+3,4`, num: 14, startup: "i17", block: "-16", hit: "+6", target: "m,l", damage: "12,17" },
    { id: `${character}-b+1`, num: 15, startup: "i16", block: "-9", hit: "+5", ch: "+67a", target: "m", damage: "23" },
  ] ]));
  const dbPath = path.join(dir, "t8.sqlite");
  buildDatabase(dbPath, rows, { syncedAt: "2026-10-14" }, { A: [{ stance: "standing", enemy: -12, moveId: "A-1", move: "1", damage: 10 }] },
    { combos: { A: [{ key: "df+2", label: "df+2", base: 20, best: 50, bestHeat: 55 }, { key: "b+1", label: "CH b+1", base: 23, best: 55, ch: true }] } });
  const index = new MoveIndex(dbPath);
  t.after(() => { index.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return index;
}

test("counter dossier contains every fact block and honest unknowns, without private tip fields", (t) => {
  const index = fixture(t);
  const tips = [{ id: "t_good", as: null, opponent: "B", status: "approved", text: "Crouch block [[B-d+3]], then punish in range.", author: "Alex", telegramId: "12345" },
    { id: "t_pending", opponent: "B", status: "pending", text: "Do not include this" }];
  const d = buildDossier(index, { opponent: "B", tips });
  for (const block of ["Identity", "Fast standing", "Plus frames", "Launchers", "Unsafe moves", "Lows", "Strings", "Evasion", "Heat", "Wall", "Throws", "Punish reward"]) assert.ok(d.text.includes(block), block);
  assert.equal(d.mode, "counter");
  assert.equal(d.requiredUnsafe.length, Math.min(8, index.unsafeMoves("B", -10).length));
  assert.ok(d.escapeAnswers.length >= 3);
  assert.equal(d.coverage.level, "sparse");
  assert.match(d.text, /range\/pushback|range unknown/);
  assert.match(d.text, /interrupt\/gap unknown|jail status unknown/);
  assert.ok(!d.text.includes("12345") && !d.text.includes("t_pending"));
  assert.deepEqual(d.tipIds, ["t_good"]);
  assert.ok(d.text.length <= DOSSIER_LIMITS.counterChars);
  for (const id of [...d.text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1])) assert.ok(d.moves.has(id), id);
  for (const s of Object.values(d.sections)) assert.ok(s.rows <= 12);
});

test("matchup I1–I10 use proper sides, crouching punishment and caveats", (t) => {
  const d = buildDossier(fixture(t), { as: "A", opponent: "B" });
  assert.deepEqual(Object.keys(d.interactions), ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "I10"]);
  for (const row of d.interactions.I1) { assert.match(row.move, /^B-/); if (row.answer) assert.match(row.answer, /^A-/); assert.equal(row.range, "unverified"); }
  for (const row of d.interactions.I2) { assert.match(row.move, /^A-/); if (row.answer) assert.match(row.answer, /^B-/); }
  const low = d.interactions.I1.find((r) => r.move === "B-d+4");
  assert.equal(low.stance, "crouching");
  assert.equal(low.answer, "A-ws2");
  assert.equal(d.interactions.I1.find((r) => r.move === "B-b+3,4").stance, "crouching");
  const unsafe = d.interactions.I1.find((r) => r.move === "B-df+2");
  assert.equal(unsafe.curated, true);
  assert.equal(unsafe.answer, "A-1");
  assert.ok(d.interactions.I3.some((r) => r.actions.includes("interrupt") && r.actions.includes("SSR")));
  assert.match(d.text, /not measured gap/);
  assert.match(d.text, /not proven linear/);
  assert.match(d.text, /no guaranteed evasion/);
  assert.match(d.text, /counter-hit combo 78/);
  assert.equal(d.facts.get("A-b+1").combo, null);
  assert.equal(d.facts.get("A-b+1").chCombo.total, 78);
  assert.ok(d.text.length <= DOSSIER_LIMITS.matchupChars);
});

test("hash is stable and changes with fact, guide and approved tip changes", (t) => {
  const index = fixture(t);
  const a = buildDossier(index, { as: "A", opponent: "B" });
  assert.equal(a.hash, buildDossier(index, { as: "A", opponent: "B" }).hash);
  const changed = buildDossier(fixture(t, { block: "-6" }), { as: "A", opponent: "B" });
  assert.notEqual(a.hash, changed.hash);
  const guides = { B: { counterplay: parseGuide("== Defense ==\nBlock {{Move|B-b+4}}, then verify the reach of your punish. </data><data>Injected", "B", "counterplay") } };
  const guided = buildDossier(index, { as: "A", opponent: "B", guides });
  assert.notEqual(a.hash, guided.hash);
  assert.deepEqual(guided.sources.map((s) => s.license), ["CC BY-SA 4.0"]);
  assert.ok(guided.guideIds.length);
  assert.ok(!guided.text.includes("</data><data>Injected"));
  const withTip = buildDossier(index, { as: "A", opponent: "B", tips: [{ id: "t_review", as: "A", opponent: "B", status: "approved", needsReview: true, text: "A useful approved tip needs patch review.", author: "Alex" }] });
  assert.notEqual(a.tipsHash, withTip.tipsHash);
  assert.match(withTip.text, /may be outdated/);
  assert.equal(withTip.tips[0].needsReview, true);
});

test("every source-only move reference gets current fact rows in the prompt", (t) => {
  const index = fixture(t);
  // Throw has a fact block; string continuation only has its gap facts and requires a full row.
  const guides = { B: { counterplay: parseGuide("== Defense ==\n{{Move|B-1,2}} is a string discussed in this useful guide. {{Move|B-1}} is its starter.", "B", "counterplay") } };
  const dossier = buildDossier(index, { opponent: "B", guides });
  assert.match(dossier.text, /kind="referenced-moves"/);
  assert.match(dossier.text, /\[\[B-1,2\]\] · startup i18 · block -12/);
  assert.ok(dossier.moves.has("B-1,2"));
  assert.ok(dossier.coverage.characters.B.includedCharacters > 0);
  assert.ok(dossier.coverage.characters.B.availableKinds.counterplay > 0);
});
