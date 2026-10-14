import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, PROMPT_VERSION } from "../src/coach/prompt.js";
import { ACTIONS, validateGuide } from "../src/coach/validate.js";
import { availableViews, renderFallback, renderGuide, renderView, splitHtml } from "../src/coach/render.js";

function fixture(mode = "matchup") {
  const moves = new Map();
  const put = (character, key, extras = {}) => {
    const id = `${character}-${key}`;
    moves.set(id, { id, character, key, startup: "15", startup_eff: 15, block: "-13", block_n: -13, target: "m", damage: "20", ...extras });
    return id;
  };
  const standing = put("Kazuya", "1,1,2", { startup: "10", startup_eff: 10, target: "h,h,m", damage: "7,8,12" });
  const crouching = put("Kazuya", "ws4", { startup: "11", startup_eff: 11 });
  const threats = ["b+4", "df+2", "d+3", "d+4", "db+4"].map((key, i) => put("Reina", key, i > 1 ? { target: "l", startup: "18" } : {}));
  const requiredUnsafe = threats.map((move, i) => ({ move, answer: mode === "matchup" ? (i > 1 ? crouching : standing) : null, stance: i > 1 ? "crouching" : "standing", window: 13, range: "unverified" }));
  const escapeAnswers = threats.slice(2).map((move) => ({ move, kind: "low", answer: mode === "matchup" ? crouching : null, actions: ["crouch_block", "punish"] }));
  const dossier = { mode, as: mode === "matchup" ? "Kazuya" : null, opponent: "Reina", language: "en", moves, requiredUnsafe, escapeAnswers, interactions: { I1: requiredUnsafe, I2: [{ move: standing, answer: threats[0] }] }, coverage: { level: "ok" }, text: "Unsafe moves have block -13. All model numbers remain forbidden. ", dataVersion: "wavu:2026-10-14", hash: "fixture", guideIds: ["Reina counterplay#Defense"], tipIds: ["t_0042"], tips: [{ id: "t_0042", author: "Alex <admin>" }], sources: [{ page: "Reina counterplay", url: "https://wavu.wiki/t/Reina_counterplay", license: "CC BY-SA 4.0" }] };
  const guide = {
    summary: "Block the committed threats and claim your punish. Keep the spacing caveat in mind.",
    gameplan: "They want to stay at close range and keep their turn with fast checks, then switch to a committal low or mid when you start to press back. Their main loop is a safe poke, a plus move, and a mixup that forces you to guess. You win by blocking the committal moves, punishing them every time, and taking your turn back after their pressure ends instead of pressing into it.",
    stances: [],
    key_threats: threats.map((move) => ({ move: `[[${move}]]`, why: "They commit to a check.", answer: "Block and punish.", reward: "Take your turn." })),
    defense: [...threats.slice(2).map((move) => ({ situation: `After [[${move}]]`, answer: `Crouch block and punish${mode === "matchup" ? ` with [[${crouching}]]` : ""}.`, reward: "Take the available punish." })),
      { situation: "When they are plus after a blocked string", answer: "Hold your guard and wait for the next committal move.", reward: "They lose their turn first." }],
    punish: requiredUnsafe.map((r) => mode === "matchup" ? { move: `[[${r.move}]]`, answer: `[[${r.answer}]]`, note: "Standing punish after the block." } : { move: `[[${r.move}]]`, answer: "Block and punish within its shown window.", priority: "high" }),
    their_turn: "Respect the evidenced pressure; reset spacing after the sequence.",
    heat_and_wall: "Heat and wall evidence is missing; test the cited punish at the wall.",
    common_mistakes: ["Pressing buttons after a plus move.", "Guessing on the low instead of blocking it.", "Forgetting the punish after a blocked launcher."],
    lab_drill: [0, 1, 2].map((i) => ({ title: `Drill ${["one", "two", "three"][i]}`, setup: "Dummy: the opponent. Record their main pressure sequence and playback random.", steps: ["Block the first hit.", "React to the follow-up with the supported answer.", "Punish when they stop early."], goal: "You answer the recording correctly most of the time." })),
    confidence: "medium", gaps: ["Reach has not been verified."], used_tips: ["t_0042"], used_guides: ["Reina counterplay#Defense"], general_knowledge: [],
  };
  guide.neutral = "Wait for a whiff at the spacing you tested.";
  if (mode === "matchup") Object.assign(guide, { your_plan: "Play at the range where the cited punish reaches.", your_best_tools: [{ move: `[[${standing}]]`, why: "The forward punish table supplies this answer." }], stop_doing: [{ move: `[[${standing}]]`, why: `The reverse table supplies [[${threats[0]}]].` }] });
  else Object.assign(guide, { neutral: "Wait for a whiff at the spacing you tested.", lows: threats.slice(2).map((move) => ({ move: `[[${move}]]`, answer: "Crouch block and punish." })) });
  const index = { move: (id) => moves.get(id) ?? null, chain: (id) => [moves.get(id)] };
  return { dossier, guide, index, standing, crouching, threats };
}

function balanced(html) {
  const stack = [];
  for (const token of html.match(/<[^>]+>/g) ?? []) {
    const close = token.match(/^<\/([a-z]+)>$/i);
    if (close) assert.equal(stack.pop(), close[1]);
    else {
      const open = token.match(/^<([a-z]+)(?:\s[^>]*)?>$/i);
      assert.ok(open, `Unexpected tag ${token}`);
      stack.push(open[1]);
    }
  }
  assert.deepEqual(stack, []);
}

test("both modes produce complete valid guides; Russian escape wording works", () => {
  for (const mode of ["matchup", "counter"]) {
    const { dossier, guide, crouching } = fixture(mode);
    assert.deepEqual(validateGuide(JSON.stringify(guide), dossier).errors, []);
    guide.defense.forEach((x) => { x.answer = `Блок сидя; накажите${mode === "matchup" ? ` [[${crouching}]]` : ""}.`; });
    assert.equal(validateGuide(guide, dossier).ok, true);
  }
});

test("numeric prose is stripped and rejected even if that number exists elsewhere in dossier", () => {
  const { dossier, guide } = fixture();
  guide.summary += " It is -13 and does 99 damage, i47 startup. Another move is −１３.";
  const result = validateGuide(guide, dossier);
  assert.equal(result.ok, false);
  assert.ok(result.strippedNumbers.some((x) => x.value === "-13"));
  assert.ok(result.strippedNumbers.some((x) => x.value === "99"));
  assert.ok(result.strippedNumbers.some((x) => x.value === "i47"));
  assert.ok(result.strippedNumbers.some((x) => x.value === "−１３"));
  assert.doesNotMatch(result.guide.summary, /13|99|47|１３/);
  assert.match(result.guide.punish[0].move, /b\+4/);
  assert.deepEqual(result.guide.used_tips, ["t_0042"]);
});

test("spelled out numerical frame/damage claims are also rejected", () => {
  const { dossier, guide } = fixture();
  guide.summary = "It deals twenty damage. Watch the second frame. Это три кадра.";
  const result = validateGuide(guide, dossier);
  assert.equal(result.ok, false);
  assert.equal(result.strippedNumbers.length, 3);
});

test("character names with digits and ordinal hit words are not numeric claims", () => {
  const { dossier, guide } = fixture();
  dossier.characterNames = ["Jack-8", "Kazuya", "Reina"];
  for (const summary of ["Jack-8 wants to stay close; duck the second hit.", "Против Jack-8 пригнитесь под второй удар.", "In Tekken 8 this is a key decision."]) {
    guide.summary = summary;
    const result = validateGuide(structuredClone(guide), dossier);
    assert.deepEqual(result.strippedNumbers, [], summary);
  }
  guide.summary = "Jack-8 has a 13 frame punish.";
  assert.deepEqual(validateGuide(structuredClone(guide), dossier).strippedNumbers.map((x) => x.value), ["13"]);
});

test("rejects unknown, malformed, wrong-side moves and made-up source IDs", () => {
  const { dossier, guide, threats } = fixture();
  guide.summary = "Try [[Jin-made-up]] and [[bad].";
  guide.your_best_tools[0].move = `[[${threats[0]}]]`;
  guide.used_guides.push("Clan-approved fantastic guide");
  const result = validateGuide(guide, dossier);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => /unknown move/.test(x)));
  assert.ok(result.errors.some((x) => /malformed/.test(x)));
  assert.ok(result.errors.some((x) => /wrong side/.test(x)));
  assert.ok(result.errors.some((x) => /unknown source/.test(x)));
});

test("requires every top unsafe punish and the exact computed relation", () => {
  const { dossier, guide, standing, crouching } = fixture();
  guide.punish.pop();
  guide.punish[0].answer = `[[${crouching}]]`;
  guide.defense[0].answer = `Crouch block and punish with [[${standing}]].`;
  const result = validateGuide(guide, dossier);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => /must cover unsafe/.test(x)));
  assert.ok(result.errors.some((x) => /computed answer/.test(x)));
  assert.ok(result.errors.some((x) => /allowed actions for this threat/.test(x)));
});

test("escape coverage requires distinct threats and backed actions", () => {
  const { dossier, guide } = fixture();
  guide.defense[0].answer = "SSR and duck.";
  guide.defense[1] = { ...guide.defense[2] };
  const result = validateGuide(guide, dossier);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => /allowed actions for this threat/.test(x)));
  assert.ok(result.errors.some((x) => /Need 3 distinct/.test(x)));
});

test("schema bounds, filler and sparse confidence are enforced", () => {
  const { dossier, guide } = fixture();
  dossier.coverage.level = "sparse";
  guide.gaps = [];
  guide.common_mistakes = Array(13).fill("Just block.");
  guide.extra = true;
  const result = validateGuide(guide, dossier);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => /more than 12 items/.test(x)));
  assert.ok(result.errors.some((x) => /generic filler/.test(x)));
  assert.ok(result.errors.some((x) => /Sparse evidence/.test(x)));
  assert.ok(result.errors.some((x) => /Unexpected field/.test(x)));
  assert.equal(validateGuide("```json\n{}\n```", dossier).ok, false);
  assert.equal(validateGuide("[]", dossier).ok, false);
});

test("prompts include task, hard numeric rule, language and explicitly synthetic style only", () => {
  const { dossier } = fixture();
  const ru = buildPrompt(dossier, { language: "ru", level: "high" });
  assert.match(ru.systemPrompt, /Пиши по-русски/);
  assert.match(ru.systemPrompt, /matching an unrelated number is not evidence/);
  assert.match(ru.messages[0].content, /synthetic/);
  assert.match(ru.messages[0].content, /minimumEscapes/);
  assert.match(ru.systemPrompt, new RegExp(PROMPT_VERSION.replaceAll(".", "\\.")));
  const en = buildPrompt({ ...dossier, mode: "counter", as: null }, { language: "en" });
  assert.match(en.systemPrompt, /Write in English/);
  assert.match(en.messages[0].content, /any character/);
});

test("renderer escapes model text, resolves current index facts and credits only clan tip authors", () => {
  const { dossier, guide, index, threats } = fixture();
  guide.summary = "<script>hack</script> & wait.";
  const m = dossier.moves.get(threats[0]);
  m.startup = "17";
  m.block = "-16";
  m.block_n = -16;
  const html = renderGuide(index, guide, dossier, { model: "openai/gpt-6-astra", createdAt: "2026-10-14T18:00:00Z" }).join("\n");
  assert.match(html, /&lt;script&gt;hack&lt;\/script&gt; &amp;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<code>b\+4<\/code> <i>\(i17 · -16/);
  assert.match(html, /Clan tips: Alex &lt;admin&gt;/);
  assert.doesNotMatch(html, /CC BY-SA|wavu|tekkendocs|Sources:/i);
  for (const part of renderGuide(index, guide, dossier)) assert.ok(part.length <= 3800);
  renderGuide(index, guide, dossier).forEach(balanced);
});

test("section rendering shows selected section, and current universal punish window", () => {
  const { dossier, guide, index, threats } = fixture("counter");
  dossier.moves.get(threats[0]).block_n = -16;
  const html = renderGuide(index, guide, dossier, { section: "punish" }).join("");
  assert.match(html, /block punish window: 16/);
  assert.match(html, /<b>Punish<\/b>/);
  assert.doesNotMatch(html, /<b>Defense<\/b>/);
});

test("HTML splitting preserves entities, Unicode and valid tags within the Telegram limit", () => {
  const long = `<b>Title</b><blockquote expandable>${("<code>b+4</code> <i>(i15, −13)</i> &amp; 🥋 ").repeat(350)}</blockquote><i>Footer</i>`;
  const parts = splitHtml(long);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 4096);
    balanced(part);
    assert.doesNotMatch(part, /&amp?$|[\uD800-\uDBFF]$/u);
  }
  const plain = (s) => s.replace(/<[^>]*>/g, "");
  assert.equal(parts.map(plain).join(""), plain(long));
});

test("fallback renders deterministic current facts and safe, bounded HTML", () => {
  const { dossier, index } = fixture();
  const parts = renderFallback(index, dossier, "Validation failed.");
  assert.match(parts.join(""), /could not produce a verified guide/);
  assert.match(parts.join(""), /<code>While standing 4<\/code>/);
  for (const part of parts) { assert.ok(part.length <= 4096); balanced(part); }
});

test("Russian sidestep/sidewalk phrasing in any verb form is recognised", () => {
  for (const [text, action] of [["шагните вправо", "SSR"], ["шагом влево", "SSL"], ["степом вправо", "SSR"], ["обходите влево", "SWL"], ["обходом вправо", "SWR"]]) {
    assert.ok(ACTIONS[action].test(text), text);
  }
});

test("general knowledge: at most two unverified items for thin guides, none for rich, no numbers", () => {
  const { dossier, guide } = fixture();
  const items = ["Reina players like to stay in her stance after blocked strings.", "She often ends pressure with a low; expect it after plus frames.", "A third point."];
  dossier.generalKnowledge = { allowed: true, max: 2 };
  assert.equal(validateGuide({ ...structuredClone(guide), general_knowledge: items.slice(0, 2) }, dossier).ok, true);
  assert.match(validateGuide({ ...structuredClone(guide), general_knowledge: items }, dossier).errors.join(";"), /at most 2/);
  assert.match(validateGuide({ ...structuredClone(guide), general_knowledge: ["Her df+2 is minus 13."] }, dossier).errors.join(";"), /numeric prose/);
  dossier.generalKnowledge = { allowed: false, max: 0 };
  assert.match(validateGuide({ ...structuredClone(guide), general_knowledge: items.slice(0, 1) }, dossier).errors.join(";"), /must be empty/);
  assert.equal(validateGuide({ ...structuredClone(guide), general_knowledge: [] }, dossier).ok, true);
});

test("renderer labels general knowledge as unverified", () => {
  const { dossier, guide, index } = fixture();
  const html = renderGuide(index, { ...guide, general_knowledge: ["Reina players like to stay in her stance."] }, dossier).join("\n");
  assert.match(html, /⚠️ General knowledge \(unverified\)/);
});

test("unsupported escape actions produce an explicit, fixable retry message", () => {
  const { dossier, guide } = fixture();
  for (const e of dossier.escapeAnswers) { e.actions = ["crouch_block"]; e.answer = null; }
  const errors = validateGuide(guide, dossier).errors.join("\n");
  assert.match(errors, /allowed actions for this threat are crouch_block; remove punish from its answer, or drop this item/);
});

test("guide views: overview teaches the gameplan; drills and stances render as blocks; empty views are hidden", () => {
  const { dossier, guide, index } = fixture("counter");
  guide.stances = [{ stance: "Senshin", entry: "f+1+2", threats: `Low from stance: [[${[...dossier.moves.keys()].find((k) => k.startsWith("Reina-d+3"))}]]`, answer: "Crouch block it." }];
  const views = availableViews(guide);
  assert.deepEqual(views, ["overview", "stances", "threats", "defense", "punish", "neutral", "heat", "mistakes", "drills", "notes"]);
  const overview = renderView(index, guide, dossier, { view: "overview" });
  assert.match(overview.html, /How they play/);
  assert.match(overview.html, /close range/);
  const drills = renderView(index, guide, dossier, { view: "drills" });
  assert.match(drills.html, /🧪 <b>Drill one<\/b>\n<i>Setup:<\/i>[^\n]*\n1\. Block the first hit\.\n2\./);
  assert.match(renderView(index, guide, dossier, { view: "stances" }).html, /🥋 <b>Senshin<\/b>/);
  for (const v of views) assert.ok(renderView(index, guide, dossier, { view: v }).html.length <= 3800);
});
