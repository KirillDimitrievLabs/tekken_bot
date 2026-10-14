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

test("Wavu combos pages: launchers, routes, Heat routes separated", async () => {
  const { parseCombos, launcherKey, parsePunishers } = await import("../src/wavu.js");
  const page = [
    "== Staples ==", "{{Combolist|",
    "; [23] EWGF", "; [20] WGF",
    ": [+51; 34] EWGF b+2,2 df+1,df+2 T! 3,1,df CD.3",
    ": [+55] EWGF ws3 T! H.2+3",
    "; [20] FC.df+4", ": [+56] (f+2),3,F~3 df+2", "; [26] CH df+2", ": [+40] x", "}}",
  ].join("\n");
  const c = parseCombos(page, "Kazuya");
  const ewgf = c.find((x) => x.key === "EWGF");
  assert.equal(ewgf.base, 23);
  assert.equal(ewgf.best, 51);       // the Heat Smash route doesn't count as the baseline
  assert.equal(ewgf.bestHeat, 55);
  assert.ok(ewgf.named);
  assert.equal(c.find((x) => x.key === "FC.df+4").best, 56);
  assert.ok(c.find((x) => x.key === "df+2").ch);
  assert.deepEqual(launcherKey("EWGF (f,n,d,df#2)"), { key: "f,n,d,df:2", ch: false });
  assert.deepEqual(launcherKey("CH (df+4,2),3"), { key: "df+4,2,3", ch: true });
  assert.equal(launcherKey("low parry"), null);
  const pun = parsePunishers("|standing={{o\n|{{o| moveId = Reina-df+2 | enemy = -15 | staple = 69 }}\n|{{o| moveId = Reina-f,n,d,df#2 | move = f,n,df#2 | enemy = -13 | staple = 78 | hard=true }}\n}}", "Reina");
  assert.deepEqual(pun.map((x) => [x.enemy, x.move, x.staple, x.hard]), [[-15, "df+2", 69, false], [-13, "f,n,df:2", 78, true]]);
});

test("step and duck tags from Wavu notes", async () => {
  const { tagsFor } = await import("../src/tags.js");
  const t = tagsFor({ notes: "* Interrupt with i11 from 1st block\n* Whiffs vs SSR from 1st block\n* Duckable", target: ",h" }, "1,2");
  assert.ok(t.includes("ssr") && t.includes("duckable") && !t.includes("ssl"));
  assert.ok(tagsFor({ notes: "* Whiffs vs SS, SW from 2nd block", target: ",m" }, "2,3,4").includes("swl"));
});

test("readable move names: stance and notation prefixes are spelled out", async () => {
  const { prettyKey, setStances, parseStances } = await import("../src/stances.js");
  const parsed = parseStances("* WGS ''(Wind God Step)'' &ndash; f,n,d,df\n* SSH ''(Senshin)'' &ndash; f+1+2\n* ws4 ''(crouching)'' &ndash; }}\n** RFF (Right Foot Forward) &ndash; 3+4");
  assert.deepEqual(Object.keys(parsed), ["WGS", "SSH", "RFF"]);
  setStances({ Reina: parsed });
  const cases = { "SSH.3": "Senshin 3", "OTG.d+4": "d+4 (grounded opponent)", "H.2+3": "Heat 2+3", "d+2,H.1+2": "d+2, Heat 1+2", "R.df+1+2": "Rage df+1+2", "SS.4": "Sidestep 4", "ws4": "While standing 4", "FC.df+3": "Full crouch df+3", "df+1": "df+1", "XYZ.1": "XYZ.1" };
  for (const [key, want] of Object.entries(cases)) assert.equal(prettyKey("Reina", key), want, key);
  setStances({});
});

test("help lists the coach commands and says which ones take time", async () => {
  const { HELP_HTML } = await import("../src/bot.js");
  assert.match(HELP_HTML, /🎓 <b>Coach \(clan members\)<\/b>/);
  assert.match(HELP_HTML, /<code>!vs &lt;character&gt;<\/code> — ⏳ full guide/);
  assert.match(HELP_HTML, /<code>!coach &lt;you&gt; vs &lt;them&gt;<\/code> — ⏳ full matchup guide/);
  assert.match(HELP_HTML, /⏳ <b>Takes time:<\/b>.*3–8 minutes/);
  assert.match(HELP_HTML, /Everything else answers in a second/);
});
