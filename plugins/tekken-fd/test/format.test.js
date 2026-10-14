import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { cleanInline, formatCard, noteItems } from "../src/format.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/Fahkumram.json", import.meta.url), "utf8"));
const byId = new Map(fx.moves.map((m) => [m.id, m]));
const chain = ["Fahkumram-3", "Fahkumram-3,1", "Fahkumram-3,1,2"].map((id) => byId.get(id));

test("wiki link and entities are cleaned", () => {
  assert.equal(cleanInline("[[Fahkumram_combos#Mini-combos|+38d (+30)]]"), "+38d (+30)");
  assert.equal(cleanInline("a &amp; b"), "a & b");
});

test("notes become plain items", () => {
  assert.deepEqual(noteItems(byId.get("Fahkumram-3,1,2").notes), [
    "Balcony Break",
    "Tornado",
    "Combo from 2nd CH with 6F delay",
    "Interrupt with i3 from 2nd block",
    "Move can be delayed by 5F",
    "Input can be delayed by 6F",
  ]);
});

test("Fahkumram 3,1,2 card matches the clan template", () => {
  const card = formatCard({ character: "Fahkumram", key: "3,1,2", chain });
  assert.equal(card, [
    "🤹🏻 Character: Fahkumram",
    "🦾 command: 3,1,2",
    "🏷 name: Ayutthaya Piercing Thunder",
    "🤜🏿 hit level: m, h, h",
    "1️⃣ damage: 11, 12, 20",
    "ℹ️ startup: i13, i18, i21~22",
    "🟦 on block: +0",
    "🟥 on hit: +38d (+30)",
    "⚡️ on counter hit: ",
    "📌 Notes:",
    "🗒  Balcony Break",
    "🗒  Tornado",
    "🗒  Combo from 2nd CH with 6F delay",
    "🗒  Interrupt with i3 from 2nd block",
    "🗒  Move can be delayed by 5F",
    "🗒  Input can be delayed by 6F",
  ].join("\n"));
});

test("notes edge cases from real Wavu data", () => {
  const icon = (cls, label) => `&lt;div\n  style=&quot;display: block;&quot;\n  class=&quot;movedata-icon ${cls}&quot;\n&gt;${label}&lt;/div&gt;`;
  // single property tag, no list (Bryan df+2)
  assert.deepEqual(noteItems(icon("border-teal tip", "Elbow")), ["Elbow"]);
  // {{Plainlist}} template wrapper (Anna CJM.df)
  assert.deepEqual(noteItems("{{Plainlist\n* Transition to r40 FC with no input\n}}"), ["Transition to r40 FC with no input"]);
  // nested bullet (Lee FC.df,d,DF+3)
  assert.deepEqual(noteItems("&lt;div class=&quot;plainlist&quot;&gt;\n* * Frame advantage depends on spacing\n* Bufferable from full crouch\n&lt;/div&gt;"),
    ["Frame advantage depends on spacing", "Bufferable from full crouch"]);
  // text right after a tag stays on that item; lone "?" placeholders dropped (Bryan 3+4,SNE.2)
  assert.deepEqual(noteItems(`&lt;div class=&quot;plainlist&quot;&gt;\n* \n${icon("balcony-break", "Balcony Break")}\n* \n${icon("tip", "Weapon")}?\n* Consumes SNE\n* ?\n&lt;/div&gt;`),
    ["Balcony Break", "Weapon?", "Consumes SNE"]);
  // empty plainlist
  assert.deepEqual(noteItems("&lt;div class=&quot;plainlist&quot;&gt;\n* \n&lt;/div&gt;"), []);
});

test("card notes header has no stray marker", () => {
  const one = formatCard({ character: "Bryan", key: "df+2", chain: [{ target: "m", damage: "12", startup: "i13", block: "-6", hit: "+5", notes: "Elbow" }] });
  assert.match(one, /📌 Notes:\n🗒  Elbow$/);
  const none = formatCard({ character: "X", key: "1", chain: [{ target: "h", damage: "5", startup: "i10" }] });
  assert.match(none, /📌 Notes: —$/);
});
