import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseCommands } from "../src/bot.js";
import { fixLayout, layoutToLatin } from "../src/nicknames.js";
import { Quiz, weekId } from "../src/quiz.js";
import { esc, isWellFormed, toPlain } from "../src/render.js";
import { gapFacts } from "../src/gaps.js";
import { heatDashOf, throwBreakOf } from "../src/db.js";
import { COMMANDS } from "../src/bot.js";

test("multi-lookup split on ; and new lines, segments inherit the command", () => {
  assert.deepEqual(parseCommands("!fd kaz df1; jin d3"), [{ cmd: "fd", args: "kaz df1" }, { cmd: "fd", args: "jin d3" }]);
  assert.deepEqual(parseCommands("!fd kaz df1\n!punish lars 14\njin 13"), [{ cmd: "fd", args: "kaz df1" }, { cmd: "punish", args: "lars 14" }, { cmd: "punish", args: "jin 13" }]);
  assert.deepEqual(parseCommands("!help"), [{ cmd: "help", args: "" }]);
  assert.equal(parseCommands("hello").length, 0);
  assert.equal(parseCommands("!fd a;b;c;d;e;f;g").length, 5);
});

test("Russian keyboard layout and Cyrillic names", () => {
  assert.equal(layoutToLatin("кфя ва1"), "raz df1");
  assert.equal(fixLayout("!ав кфя ва1", COMMANDS), "!fd raz df1");
  assert.equal(fixLayout("!ав икнфт 4", COMMANDS), "!fd bryan 4");
  assert.equal(fixLayout("!ав казуя ва1", COMMANDS, new Set(["казуя"])), "!fd казуя df1");
  assert.equal(fixLayout("!згтшыр дфкы 14", COMMANDS), "!punish lars 14");
  assert.equal(fixLayout("!fd kaz df1", COMMANDS), "!fd kaz df1");
  assert.equal(fixLayout("!привет", COMMANDS), "!привет"); // not a command → untouched
});

test("HTML rendering is escaped and well-formed", () => {
  assert.equal(esc("<b> & </b>"), "&lt;b&gt; &amp; &lt;/b&gt;");
  assert.ok(isWellFormed("<b>x</b> <code>y</code><blockquote expandable>z</blockquote>"));
  assert.ok(!isWellFormed("<b>x</i>"));
  assert.ok(!isWellFormed("<span>x</span>"));
  assert.equal(toPlain("<b>a</b> &lt;3 &amp; <code>df+1</code>"), "a <3 & df+1");
});

test("note parsers: gaps, throw breaks, heat dash", () => {
  const f = gapFacts({ notes: "* Combo from 1st CH with 2f delay\n* Interrupt with i5 from 1st block\n* Move can be delayed by 5F" });
  assert.deepEqual(f.comboCh, { from: 1, delay: "2f" });
  assert.equal(f.comboHit, null);
  assert.deepEqual(f.interrupt, { frames: 5, from: 1, on: "block" });
  assert.equal(f.delay, "5F");
  assert.deepEqual(gapFacts({ notes: "* Combo from 1st CH or 2nd hit with 4f delay\n* Jails from 1st block" }).comboHit, { from: 2, delay: "4f" });
  assert.ok(gapFacts({ notes: "* Jails from 1st block" }).jail);
  assert.equal(throwBreakOf("* Throw break: 1 or 2"), "1 or 2");
  assert.equal(throwBreakOf("* Throw break 1+2\n* Side switch"), "1+2");
  assert.equal(throwBreakOf("* Unbreakable"), "none");
  assert.equal(throwBreakOf("* 1 throw break."), "1");
  assert.equal(throwBreakOf("* 1+2 throw break. Side switch."), "1+2");
  assert.equal(throwBreakOf("* 1 or 2 throw break, depending on King's input"), "1 or 2");
  assert.equal(throwBreakOf("* Crouch throw, cannot throw break."), "none");
  assert.equal(heatDashOf("* Heat Dash +5, +43d (+35)"), "+5, +43d (+35)");
});

test("quiz: one answer each, every correct answer scores, reveal, leaderboard, daily slot", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "quiz-")), "q.json");
  let now = Date.parse("2026-10-14T16:00:00Z"); // 19:00 Moscow
  const qz = new Quiz(file, { now: () => now });
  const id = qz.create("-100", { character: "Jin", key: "d+3", prompt: "on block?", options: ["-12", "-14", "-13", "-16"], correct: 1, detail: "-14" });
  assert.equal(qz.answer(id, "1", "@a", 1).correct, true);
  assert.equal(qz.answer(id, "1", "@a", 2).status, "duplicate");
  assert.equal(qz.answer(id, "2", "@b", 1).correct, true);
  assert.equal(qz.answer(id, "3", "@c", 0).correct, false);
  const html = qz.reveal(id);
  assert.match(toPlain(html), /✅ -14/);
  assert.match(toPlain(html), /🏆 @a, @b/);
  assert.match(toPlain(html), /❌ @c \(-12\)/);
  assert.equal(qz.answer(id, "4", "@d", 1).status, "closed");
  assert.match(toPlain(qz.leaderboard("-100")), /🥇 @a — 1/);
  assert.equal(qz.dueDaily("-100", { dailyAt: "19:00", tz: "Europe/Moscow" }), true);
  assert.equal(qz.dueDaily("-100", { dailyAt: "19:00", tz: "Europe/Moscow" }), false); // once a day
  now = Date.parse("2026-10-14T15:00:00Z"); // 18:00 Moscow, before the slot
  assert.equal(qz.dueDaily("-200", { dailyAt: "19:00", tz: "Europe/Moscow" }), false);
  assert.match(weekId(new Date("2026-10-14T00:00:00Z")), /^2026-W42$/);
});
