import assert from "node:assert/strict";
import { test } from "node:test";
import { looseKey, moveKeyFromId, strictKey } from "../src/notation.js";

test("strict keeps separators", () => {
  assert.equal(strictKey("3,1,2"), "3,1,2");
  assert.equal(strictKey("3 1 2"), "3,1,2");
  assert.equal(strictKey("d/f+1"), "df+1");
  assert.equal(strictKey("FC.df+1"), "fcdf+1");
  assert.equal(strictKey("H.2+3"), "h2+3");
  assert.equal(strictKey("heat 2+3"), "h2+3");
  assert.notEqual(strictKey("1,2"), strictKey("1+2"));
});

test("loose collapses separators", () => {
  for (const q of ["312", "3 1 2", "3,1,2", "3, 1, 2"]) assert.equal(looseKey(q), "312");
  assert.equal(looseKey("df1"), looseKey("df+1"));
  assert.equal(looseKey("ws2"), looseKey("WS.2"));
  assert.equal(looseKey("while standing 2"), "ws2");
  assert.equal(looseKey("b1+2"), looseKey("b+1+2"));
});

test("move key strips character prefix, including hyphenated names", () => {
  assert.equal(moveKeyFromId("Fahkumram-3,1,2", "Fahkumram"), "3,1,2");
  assert.equal(moveKeyFromId("Jack-8-1,2", "Jack-8"), "1,2");
});
