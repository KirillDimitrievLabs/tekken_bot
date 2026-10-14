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
    "📌 Notes: 🗒",
    "🗒  Balcony Break",
    "🗒  Tornado",
    "🗒  Combo from 2nd CH with 6F delay",
    "🗒  Interrupt with i3 from 2nd block",
    "🗒  Move can be delayed by 5F",
    "🗒  Input can be delayed by 6F",
    "— wavu.wiki",
  ].join("\n"));
});
