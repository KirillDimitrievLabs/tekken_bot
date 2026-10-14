import assert from "node:assert/strict";
import { test } from "node:test";
import { auditSnapshots, summarizeAudit } from "../src/audit.js";

const row = (id, notes, extra = {}) => ({ id, notes, name: null, target: "m", damage: "10", startup: "i12", block: "-1", hit: "+2", ch: null, crush: null, recv: null, ...extra });

test("clean data, including legit '>' text, has no issues", () => {
  const r = auditSnapshots(new Map([["Anna", [
    row("Anna-1", "&lt;div class=&quot;plainlist&quot;&gt;\n* 2nd hit damage 11 &gt; 18 if 1st hit whiffs\n&lt;/div&gt;", { name: "Uppercut Jab &gt; Radiant Arch" }),
    row("Anna-2", "{{Plainlist\n* Transition to FC\n}}"),
  ]]]));
  assert.equal(r.issues.length, 0);
  assert.equal(summarizeAudit(r), "");
});

test("unknown templates, tables and tags are reported", () => {
  const r = auditSnapshots(new Map([["Lili", [
    row("Lili-1", "{{Hlist|Homing|Tornado}}"),
    row("Lili-2", "{| class=&quot;wikitable&quot;\n|-\n| a || b\n|}"),
    row("Lili-3", "* Power crush", { hit: "+5 &lt;span" }),
  ]]]));
  const ids = new Set(r.issues.map((i) => i.id));
  assert.deepEqual([...ids].sort(), ["Lili-1", "Lili-2", "Lili-3"]);
  assert.match(summarizeAudit(r), /^⚠️ 3 move\(s\)/);
});
