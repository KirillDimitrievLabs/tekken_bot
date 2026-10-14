// /meta_build: ranked matchup statistics → data/wank/t8-matchups.json (aggregates only) → git commit.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fetchMatchupStats } from "./wank.js";

const run = promisify(execFile);
export const META_STEPS = [["replays", "Ranked replays"], ["map", "Character ids"], ["save", "Save & commit"], ["push", "GitHub push"]];
export const statsPath = (repoDir) => path.join(repoDir, "data", "wank", "t8-matchups.json");

export function readStats(repoDir) {
  try { return JSON.parse(fs.readFileSync(statsPath(repoDir), "utf8")); } catch { return null; }
}

/**
 * @param {{days?: number, progress?: import("./progress.js").ProgressBoard, fetchImpl?: Function, pauseMs?: number}} opts
 * @returns {Promise<{commit: string|null, stats: object, message: string}>}
 */
export async function buildMeta(repoDir, characters, { days = 7, progress, fetchImpl, pauseMs } = {}) {
  const step = (id, state, detail) => progress?.update(id, state, detail);
  step("replays", "run", "starting");
  let stats;
  try {
    stats = await fetchMatchupStats(characters, { days, fetchImpl, pauseMs, onProgress: (e) => {
      if (e.phase === "replays") step("replays", "run", `${e.done}/${e.total} windows · ${e.replays.toLocaleString("en")} games · v${e.gameVersion}`);
      else { step("replays", "done", null); step("map", "run", `${e.done}/${e.total} · ${e.character}`); }
    } });
  } catch (err) {
    step(progress?.step("map")?.state === "run" ? "map" : "replays", "fail", err.message);
    throw err;
  }
  const covered = Object.keys(stats.characters).length;
  step("replays", "done", `${stats.replays.toLocaleString("en")} games, ${stats.from.slice(0, 10)} → ${stats.to.slice(0, 10)}${stats.stoppedAtPatch ? " (patch start)" : ""}`);
  if (covered < characters.length * 0.9 || stats.replays < 10000) {
    step("map", "fail", `only ${covered}/${characters.length} characters mapped, ${stats.replays} games`);
    throw new Error(`too little data (${stats.replays} games, ${covered} characters mapped); previous stats kept`);
  }
  step("map", stats.unmappedCharacterIds.length ? "warn" : "done", `${covered}/${characters.length} characters${stats.unmappedCharacterIds.length ? `, unmapped ids ${stats.unmappedCharacterIds.join(",")}` : ""}`);
  step("save", "run", "writing");
  const file = statsPath(repoDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(stats, null, 1)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  const rel = path.relative(repoDir, file);
  const git = (...a) => run("git", ["-C", repoDir, ...a]);
  await git("add", "--", rel);
  const staged = (await git("diff", "--cached", "--name-only", "--", rel)).stdout.trim();
  let commit = null;
  if (staged) {
    await git("commit", "--quiet", "--only", "-m", `data: ranked matchup stats ${stats.to.slice(0, 10)} (${stats.replays} games, v${stats.gameVersion})`, "--", rel);
    commit = (await git("rev-parse", "--short", "HEAD")).stdout.trim();
  }
  step("save", "done", commit ? `commit ${commit}` : "unchanged");
  return { commit, stats, message: `📊 Ranked matchup stats: ${stats.replays.toLocaleString("en")} games (${stats.from.slice(0, 10)} → ${stats.to.slice(0, 10)}, game v${stats.gameVersion}), ${Object.keys(stats.matchups).length} matchups.${commit ? ` Commit ${commit}.` : ""}` };
}
