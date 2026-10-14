import assert from "node:assert/strict";
import { test } from "node:test";
import { characterFromPage, dedupeById } from "../src/wavu.js";

test("character from Cargo page name", () => {
  assert.equal(characterFromPage("Jack-8 movelist"), "Jack-8");
  assert.equal(characterFromPage("Devil Jin movelist"), "Devil Jin");
  assert.equal(characterFromPage("Generic movelist"), null);
  assert.equal(characterFromPage("Heat"), null);
  assert.equal(characterFromPage("Jin movelist (Tekken 6)"), null);
});

test("duplicate ids keep the most complete row", () => {
  const rows = [
    { id: "Panda-d+3+4", num: null, recv: null, block: "-12" },
    { id: "Panda-d+3+4", num: "31", recv: "r15 SIT", block: "-12" },
    { id: "Panda-1", num: "1", recv: null, block: "+1" },
  ];
  const out = dedupeById(rows);
  assert.equal(out.length, 2);
  assert.equal(out.find((m) => m.id === "Panda-d+3+4").num, "31");
});
