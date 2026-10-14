import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { guideNodes, guideTitle, TelegraphClient } from "../src/coach/telegraph.js";
import { setStances } from "../src/stances.js";

const moves = new Map([["Reina-SSH.3", { id: "Reina-SSH.3", character: "Reina", key: "SSH.3", startup: "i20", block: "-13", block_n: -13, target: "l" }]]);
const index = { move: (id) => moves.get(id) ?? null, chain: (id) => [moves.get(id)] };
const dossier = { mode: "counter", opponent: "Reina", language: "en", tips: [{ id: "t_0001", author: "Alex Smith" }] };
const guide = {
  summary: "Reina rushes you down. Tip from Alex Smith: block low after [[Reina-SSH.3]].", gameplan: "She wants close range.", stances: [{ stance: "Senshin", entry: "f+1+2", threats: "[[Reina-SSH.3]]", answer: "Crouch block." }],
  key_threats: [{ move: "[[Reina-SSH.3]]", why: "A low.", answer: "Crouch block.", reward: "Punish." }], defense: [], punish: [{ move: "[[Reina-SSH.3]]", answer: "Crouching punish.", priority: "high" }], lows: [],
  their_turn: "x", neutral: "y", heat_and_wall: "z", common_mistakes: ["Standing on her lows."],
  lab_drill: [{ title: "Lows", setup: "Record [[Reina-SSH.3]].", steps: ["Block low.", "Punish."], goal: "Every time." }],
  confidence: "medium", gaps: [], general_knowledge: [], used_tips: ["t_0001"], used_guides: [],
};

test("guide page: readable names, no tip author names, drills as ordered lists, one source credit", () => {
  setStances({ Reina: { SSH: { name: "Senshin", input: "f+1+2" } } });
  const json = JSON.stringify(guideNodes(index, guide, dossier, { model: "openai/gpt-6.1-sol", createdAt: "2026-10-14T20:00:00Z" }));
  setStances({});
  assert.match(json, /"tag":"code","children":\["Senshin 3"\]/);
  assert.doesNotMatch(json, /Alex Smith/);
  assert.match(json, /a clan member/);
  assert.match(json, /"tag":"ol","children":\[\{"tag":"li"/);
  assert.match(json, /punish window 13/);
  assert.equal((json.match(/wavu\.wiki/g) ?? []).length, 1);
  assert.match(json, /Includes 1 approved clan tip/);
  assert.equal(guideTitle(dossier), "How to play against Reina — Tekken 8 guide");
});

test("telegraph client: one account, create once, then edit the same path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgph-"));
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    const params = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ method, params });
    const result = method === "createAccount" ? { access_token: "tok", short_name: "TekkenCoach" } : { path: params.path ?? "How-to-play-10-14", url: `https://telegra.ph/${params.path ?? "How-to-play-10-14"}` };
    return { json: async () => ({ ok: true, result }) };
  };
  const client = new TelegraphClient({ stateDir: dir, fetchImpl });
  const first = await client.publish({ title: "T", content: [{ tag: "p", children: ["a"] }] });
  const second = await client.publish({ pagePath: first.path, title: "T", content: [{ tag: "p", children: ["b"] }] });
  assert.deepEqual(calls.map((c) => c.method), ["createAccount", "createPage", "editPage"]);
  assert.equal(second.url, first.url);
  assert.equal(calls[1].params.access_token, "tok");
  assert.equal(fs.statSync(path.join(dir, "telegraph.json")).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
