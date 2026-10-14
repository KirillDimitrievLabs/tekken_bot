import assert from "node:assert/strict";
import { test } from "node:test";
import { bestBand, characterStat, MatchupAggregator, matchCharacterName, matchupStat, parseLeaderboardNav, parseLeaderboardPlayers, verdict, voteCharacterIds } from "../src/wank.js";

const replay = (a, b, winner, { r1 = 27, r2 = 27, p1 = "P1", p2 = "P2", t = 1000 } = {}) => ({
  battle_at: t, game_version: 30202, p1_chara_id: a, p2_chara_id: b, winner, p1_rank: r1, p2_rank: r2,
  p1_polaris_id: p1, p2_polaris_id: p2, p1_rating_before: 2000, p2_rating_before: 2000,
});

test("aggregates per unordered pair from the first name's view, by band, without player data", () => {
  const agg = new MatchupAggregator();
  for (let i = 0; i < 600; i++) agg.add(replay(8, 33, i % 10 < 6 ? 1 : 2)); // id 8 wins 60% as p1
  for (let i = 0; i < 400; i++) agg.add(replay(33, 8, i % 4 === 0 ? 1 : 2, { r1: 10 })); // id 33 p1 wins 25%, low rank
  agg.add(replay(8, 8, 1)); // mirror: counted for the character, not for any pair
  const snap = agg.snapshot({ 8: "Kazuya", 33: "Reina" }, { gameVersion: 30202 });
  assert.deepEqual(Object.keys(snap.matchups), ["Kazuya|Reina"]);
  const all = matchupStat(snap, "Kazuya", "Reina", "all");
  assert.equal(all.games, 1000);
  assert.equal(all.winRate, (360 + 300) / 1000);
  assert.equal(matchupStat(snap, "Reina", "Kazuya", "all").winRate, 0.34);
  assert.equal(matchupStat(snap, "Kazuya", "Reina", "king").games, 600); // low-rank games excluded
  assert.equal(matchupStat(snap, "Kazuya", "Reina", "all").adjusted, all.winRate); // equal ratings → expectation 0.5
  assert.equal(bestBand(snap, "Kazuya", "Reina").band, "king");
  assert.equal(characterStat(snap, "Kazuya", "all").games, 1002);
  assert.doesNotMatch(JSON.stringify(snap), /P1|P2|polaris/);
});

test("small samples are hidden or flagged; verdict words", () => {
  const agg = new MatchupAggregator();
  for (let i = 0; i < 100; i++) agg.add(replay(1, 2, 1));
  const snap = agg.snapshot({ 1: "Law", 2: "King" }, {});
  assert.equal(matchupStat(snap, "Law", "King", "all"), null);
  assert.deepEqual([0.6, 0.53, 0.5, 0.46, 0.4].map(verdict), ["favourable", "slightly favourable", "even", "slightly hard", "hard"]);
});

test("character ids are mapped by leaderboard majority; names normalise", () => {
  const seen = new Map([["a", new Map([[8, 50], [33, 2]])], ["b", new Map([[8, 9]])], ["c", new Map([[33, 30]])], ["d", new Map([[33, 7]])]]);
  assert.deepEqual(voteCharacterIds(seen, new Map([["Kazuya", ["a", "b"]], ["Reina", ["c", "d", "a"]]])), { 8: "Kazuya", 33: "Reina" });
  assert.equal(matchCharacterName("Jack-8", ["Jack-8", "Jin"]), "Jack-8");
  assert.equal(matchCharacterName("Mains", ["Jin"]), null);
  const html = '<a href="/leaderboard/eu/ak">Armor King</a><a href="/leaderboard/eu/dj">Devil Jin</a><a href="/player/2eq7Rr4Q58aj">x</a>';
  assert.deepEqual(parseLeaderboardNav(html), [{ slug: "ak", name: "Armor King" }, { slug: "dj", name: "Devil Jin" }]);
  assert.deepEqual(parseLeaderboardPlayers(html), ["2eq7Rr4Q58aj"]);
});
