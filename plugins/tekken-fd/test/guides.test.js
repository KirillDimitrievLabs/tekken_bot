import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchGuides, guideCoverage, linkGuideMoves, mergeGuideSnapshots, parseGuide, selectGuides } from "../src/guides.js";

const moves = [
  { id: "Reina-b+4", character: "Reina", key: "b+4" },
  { id: "Reina-df+1", character: "Reina", key: "df+1" },
  { id: "Reina-1,2", character: "Reina", key: "1,2" },
];

test("guide parser retains heading paths, lists, matching moves and readable links", () => {
  const parsed = parseGuide(`{{Navbox|irrelevant}}\n== Key moves ==\n* {{Move|Reina-b+4}} keeps you honest. Use df+1 after checking the range.\n* [[Tekken 8|the game]] and [[Reina-b+999]] unknown move.\n=== Neutral ===\nRespect 1,2 and [https://example.com the guide]. {{Nested|{{ignored|x}}}}\n<ref>discard reference content</ref>`, "Reina", "strategy", { moves });
  assert.deepEqual(parsed.sections.map((s) => s.heading), [["Key moves"], ["Key moves", "Neutral"]]);
  assert.match(parsed.sections[0].text, /\[\[Reina-b\+4\]\]/);
  assert.match(parsed.sections[0].text, /\[\[Reina-df\+1\]\]/);
  assert.match(parsed.sections[0].text, /^- /);
  assert.match(parsed.sections[0].text, /the game/);
  assert.ok(!parsed.sections[0].text.includes("[[Reina-b+999]]"));
  assert.ok(!JSON.stringify(parsed).includes("discard reference content"));
  assert.ok(!JSON.stringify(parsed).includes("Nested"));
  assert.match(parsed.sections[1].text, /\[\[Reina-1,2\]\]/);
  assert.equal(parsed.license, "CC BY-SA 4.0");
});

test("only unique indexed notation links, and template-only coverage stays sparse", () => {
  const duplicate = [...moves, { id: "Reina-df+1:alt", key: "df+1", character: "Reina" }];
  assert.equal(linkGuideMoves("df+1", "Reina", duplicate), "df+1");
  assert.equal(linkGuideMoves("[[Ghost-b+4]]", "Reina", moves), "Ghost-b+4");
  const template = parseGuide("{{Navbox|Reina}}\n== Counterplay ==\n{{Stub}}", "Reina", "counterplay");
  assert.equal(template.coverage, 0);
  assert.equal(guideCoverage({ counterplay: template }).level, "sparse");
});

test("selection prioritizes key strategy headings and reserves tech for player side", () => {
  const guides = { Reina: {
    counterplay: parseGuide("== Defense ==\nBlock b+4, then choose a punish that reaches the opponent.", "Reina", "counterplay"),
    strategy: parseGuide("== Key moves ==\nUse df+1 to check the opponent in close range.\n== Trivia ==\nThis should never be selected, though it is valid prose.", "Reina", "strategy"),
    tech: parseGuide("== Setup ==\nThis technical setup should only be selected for the player's side.", "Reina", "tech"),
  } };
  const selected = selectGuides(guides, "Reina", { moves, maxChars: 250 });
  assert.ok(selected.some((s) => s.kind === "counterplay"));
  assert.ok(selected.some((s) => s.kind === "strategy"));
  assert.ok(!selected.some((s) => s.kind === "tech"));
  assert.ok(selected.findIndex((s) => s.heading.includes("Key moves")) < selected.findIndex((s) => s.heading.includes("Trivia")));
  assert.ok(selected.reduce((n, s) => n + s.text.length, 0) <= 250);
  assert.ok(selectGuides(guides, "Reina", { as: true, moves, maxChars: 1000 }).some((s) => s.kind === "tech"));
});

test("comprehensive strategy includes generic headings and reports every scoped/budget omission", () => {
  const guides = { Reina: {
    strategy: parseGuide("== Approach ==\nApproach with measured movement and check the opponent's whiffs.\n== Movement ==\nMovement controls spacing and creates useful whiff punishment chances.\n== Mixup ==\nThe mixup requires a read on their standing or crouching defense.\n== Key moves ==\nThese key moves deserve priority before the broader strategy sections.", "Reina", "strategy"),
    tech: parseGuide("== Setup ==\nTechnical setups belong only to the character used by the reader.", "Reina", "tech"),
  } };
  const complete = selectGuides(guides, "Reina", { maxChars: 2000, withReport: true });
  assert.equal(complete.sections[0].heading[0], "Key moves");
  for (const heading of ["Approach", "Movement", "Mixup"]) assert.ok(complete.sections.some((s) => s.heading.includes(heading)), heading);
  assert.equal(complete.report.selectedSections, 4);
  assert.equal(complete.report.omittedSections.length, 1);
  assert.equal(complete.report.omittedSections[0].reason, "tech-player-only");
  const bounded = selectGuides(guides, "Reina", { maxChars: 95, withReport: true });
  assert.equal(bounded.report.availableSections, bounded.report.selectedSections + bounded.report.omittedSections.length);
  assert.ok(bounded.report.omittedSections.some((s) => s.reason === "source-budget"));
});

test("fetch reports partial failures per page and merging preserves previous good pages", async () => {
  const updates = [];
  const r = await fetchGuides(["Reina", "Anna"], { pauseMs: 0, withReport: true, onProgress: (p) => updates.push(p), fetchImpl: async (url) => {
    const page = new URL(url).searchParams.get("page");
    if (page === "Reina tech") throw new Error("network failed");
    return { ok: true, json: async () => page.startsWith("Anna") ? { error: { code: "missingtitle" } } : { parse: { wikitext: { "*": "== Key moves ==\nUse b+4 when the opponent is in range, respecting its block punishment." } } } };
  } });
  assert.equal(r.report.ok, 1);
  assert.deepEqual(r.report.errors, ["Reina"]);
  assert.deepEqual(r.report.missing, ["Anna"]);
  assert.deepEqual(r.report.failedKinds.Reina, ["tech"]);
  assert.deepEqual(updates.map((p) => p.status), ["error", "missing"]);
  const oldTech = parseGuide("A previous useful technical guide with enough text to retain it.", "Reina", "tech");
  const oldAnna = parseGuide("A previous useful counterplay page with enough text to retain it.", "Anna", "counterplay");
  const merged = mergeGuideSnapshots({ Reina: { tech: oldTech }, Anna: { counterplay: oldAnna } }, r.data, r.report);
  assert.equal(merged.Reina.tech, oldTech);
  assert.equal(merged.Anna.counterplay, oldAnna);
  assert.deepEqual(Object.keys(merged), ["Anna", "Reina"]);
});

test("matchup selection prefers the other side and tech retains budget after rich strategy", () => {
  const guides = { Reina: {
    counterplay: parseGuide("== Match-ups ==\nGeneral matchup overview for this character.\n=== Kazuya vs Reina ===\nA useful Kazuya-specific defense note with enough text.\n=== Asuka ===\nAn unrelated Asuka-specific defense note with enough text.", "Reina", "counterplay"),
    strategy: parseGuide(`== Key moves ==\n${"Useful neutral strategy and details about matchup decisions. ".repeat(100)}`, "Reina", "strategy"),
    tech: parseGuide("== Setup ==\nThe player's useful technical setup must retain its own prompt budget.", "Reina", "tech"),
  } };
  const selected = selectGuides(guides, "Reina", { as: true, opponent: "Kazuya", moves, maxChars: 1000 });
  assert.match(selected[0].id, /Kazuya vs Reina/);
  assert.ok(!selected.some((s) => s.heading.includes("Asuka")));
  assert.ok(selected.some((s) => s.kind === "tech"));
  assert.ok(selected.reduce((n, s) => n + s.text.length, 0) <= 1000);
});

test("fetch has a deadline and retries transient server failures without retrying missing pages", async () => {
  const calls = new Map();
  const result = await fetchGuides(["Reina"], { pauseMs: 0, withReport: true, fetchImpl: async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    const page = new URL(url).searchParams.get("page");
    calls.set(page, (calls.get(page) ?? 0) + 1);
    if (page === "Reina counterplay" && calls.get(page) === 1) return { ok: false, status: 503 };
    if (page === "Reina tech") return { ok: false, status: 404 };
    return { ok: true, json: async () => ({ parse: { wikitext: { "*": "An informative guide with enough useful defense text to be retained." } } }) };
  } });
  assert.equal(calls.get("Reina counterplay"), 2);
  assert.equal(calls.get("Reina tech"), 1);
  assert.equal(result.report.errors.length, 0);
  assert.equal(result.report.ok, 1);
});
