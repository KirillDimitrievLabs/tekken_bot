import assert from "node:assert/strict";
import { test } from "node:test";
import { blockOf, effectiveStartup, isLauncher, isMotionInput, levelClass, stanceOf, startupOf } from "../src/frames.js";
import { diffFrames, formatDigest, hasFrameChanges } from "../src/digest.js";
import { resolveFilter, tagsFor } from "../src/tags.js";

test("frame parsing on real Wavu shapes", () => {
  assert.equal(startupOf("i15~16"), 15);
  assert.equal(startupOf("i13 i24~25"), 13);
  assert.equal(startupOf(null), null);
  assert.equal(blockOf("-14~-13"), -13);
  assert.equal(blockOf("+5c"), 5);
  assert.equal(blockOf("!"), null);
  assert.ok(isLauncher("+38a (+30)"));
  assert.ok(isLauncher("+67a"));
  assert.ok(!isLauncher("+38d (+30)"));
  assert.equal(levelClass("L"), "low");
  assert.equal(levelClass("sm"), "mid");
  assert.equal(levelClass("th(h)"), "throw");
});

test("stances for punishing", () => {
  for (const k of ["1,2", "df+1", "d+3+4", "b+1+2", "uf+4"]) assert.equal(stanceOf(k), "standing", k);
  for (const k of ["ws2", "ws1+2", "FC.df+1"]) assert.equal(stanceOf(k), "crouching", k);
  for (const k of ["BT.2", "SS.1", "H.2+3", "R.df+1+2", "f,F+2", "f,f,n,1+2", "Back throw", "(Back to wall).b"]) assert.equal(stanceOf(k), "other", k);
});

test("tags and filters", () => {
  const m = { notes: "&lt;div class=&quot;plainlist&quot;&gt;\n* Homing\n* Balcony Break\n&lt;/div&gt;", crush: "pc8~20", target: "m", hit: "+67a", block: "-14" };
  const tags = tagsFor(m, "df+2");
  for (const t of ["homing", "balcony", "powercrush", "mid", "launcher"]) assert.ok(tags.includes(t), t);
  assert.ok(!tags.includes("safe"));
  assert.equal(resolveFilter("Lows"), "low");
  assert.equal(resolveFilter("power crush"), "powercrush");
  assert.equal(resolveFilter("heat engagers"), "engager");
  assert.equal(resolveFilter("bananas"), null);
});

test("digest shows frame changes, ignores notes-only edits", () => {
  const a = { id: "Kazuya-df+1", block: "-7", startup: "i15~16", notes: "x" };
  const before = new Map([["Kazuya", [a, { id: "Kazuya-1", block: "+1" }]]]);
  const after = new Map([["Kazuya", [{ ...a, block: "-5", notes: "y" }, { id: "Kazuya-1", block: "+1", notes: "changed" }, { id: "Kazuya-2", block: "-3" }]]]);
  const d = diffFrames(before, after);
  assert.ok(hasFrameChanges(d));
  assert.equal(d.changes.length, 1);
  const text = formatDigest(d, { date: "2026-10-20" });
  assert.match(text, /Kazuya df\+1: block -7 → -5/);
  assert.match(text, /🆕 Kazuya: 1 new move\(s\): 2/);
  assert.ok(!hasFrameChanges(diffFrames(before, new Map([["Kazuya", before.get("Kazuya").map((m) => ({ ...m, notes: "z" }))]]))));
});

test("input timing: buffering, WGF family, Jet Upper type", async () => {
  const { inputTiming } = await import("../src/frames.js");
  for (const k of ["f,n,d,df+2", "f,n,d,df:2", "qcf+1", "b,f+2", "d,df+1", "hcb,f+1+2"]) assert.ok(isMotionInput(k), k);
  for (const k of ["1,2", "df+1", "d+1,2", "ws2", "1+2"]) assert.ok(!isMotionInput(k), k);
  assert.equal(inputTiming("f,n,d,df+2", { startup: "i11~12" }).eff, 13);           // WGF via f,d,df shortcut
  assert.match(inputTiming("f,n,d,df+2", { startup: "i11~12" }).note, /i15 full motion/);
  assert.match(inputTiming("f,n,d,df:2", { startup: "i11~12" }).note, /i14 full motion/); // EWGF
  assert.equal(inputTiming("f,n,b+2", { startup: "i14" }).eff, 14);                 // Lars / Bryan jet upper
  assert.equal(inputTiming("f,b+2", { startup: "i14" }).eff, 14);                   // Shaheen
  assert.equal(inputTiming("qcf+2", { startup: "i14~15", notes: "* Can be buffered" }).eff, 14);
  assert.equal(inputTiming("qcf+2", { startup: "i16", notes: "* Cannot be buffered" }).eff, 18);
  assert.equal(inputTiming("b,f+2", { startup: "i15~16" }).eff, 16);                // unknown → ≈ +1
  assert.match(inputTiming("b,f+2", { startup: "i15~16" }).note, /≈/);
  assert.equal(inputTiming("df+1", { startup: "i13" }).eff, 13);
});
