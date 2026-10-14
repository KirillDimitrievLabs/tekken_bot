// Sync pipeline: Wavu → snapshots (git) → SQLite index.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { auditSnapshots, summarizeAudit } from "./audit.js";
import { buildDatabase } from "./db.js";
import { diffFrames } from "./digest.js";
import { counter, reportText } from "./progress.js";
import { assertPlausible, diffSnapshots, readMeta, readSnapshots, writeSnapshots } from "./snapshot.js";
import { fetchAllMoves, fetchCombos, fetchPunishers, fetchTekkenDocsTags } from "./wavu.js";
import { fetchGuides, mergeGuideSnapshots } from "./guides.js";
import { fetchStances } from "./stances.js";
import fs from "node:fs";

const run = promisify(execFile);

export function paths(repoDir, stateDir) {
  return {
    repoDir,
    dataDir: path.join(repoDir, "data", "wavu", "t8"),
    punishersPath: path.join(repoDir, "data", "wavu", "t8-punishers.json"),
    combosPath: path.join(repoDir, "data", "wavu", "t8-combos.json"),
    tdTagsPath: path.join(repoDir, "data", "tekkendocs", "t8-tags.json"),
    guidesPath: path.join(repoDir, "data", "wavu", "t8-guides.json"),
    stancesPath: path.join(repoDir, "data", "wavu", "t8-stances.json"),
    dbPath: path.join(stateDir, "t8.sqlite"),
    statePath: path.join(stateDir, "state.json"),
  };
}

async function git(repoDir, ...args) {
  const { stdout } = await run("git", ["-C", repoDir, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export function summarize(changes, limit = 12) {
  const shown = changes.slice(0, limit).map((c) => `${c.character} (+${c.added} −${c.removed} ~${c.changed})`);
  if (changes.length > limit) shown.push(`…and ${changes.length - limit} more`);
  return shown.join(", ");
}

/** Rebuild the SQLite index from the committed snapshots. */
export function rebuild(p) {
  const snapshots = readSnapshots(p.dataDir);
  if (snapshots.size === 0) throw new Error("no snapshots in repo — run /fd_sync first");
  const meta = readMeta(p.dataDir) ?? {};
  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {}; // optional source not synced yet
    }
  };
  buildDatabase(p.dbPath, snapshots, { syncedAt: meta.syncedAt ?? "", source: "wavu.wiki" }, readJson(p.punishersPath),
    { combos: readJson(p.combosPath), tdTags: readJson(p.tdTagsPath) });
  return { characters: snapshots.size, moves: [...snapshots.values()].reduce((n, m) => n + m.length, 0) };
}

/**
 * @param {{dryRun?: boolean, force?: boolean, progress?: import("./progress.js").ProgressBoard}} opts
 *   progress: optional board updated per step (moves, punishers, combos, tags, guides, save).
 * @returns {Promise<{changed: boolean, changes: object[], commit?: string, totals: object, message: string}>}
 */
export async function sync(p, { dryRun = false, force = false, fetchImpl, progress } = {}) {
  const step = (id, state, detail) => progress?.update(id, state, detail);
  const before = readSnapshots(p.dataDir);
  step("moves", "run", "starting");
  let after;
  try {
    after = await fetchAllMoves({ fetchImpl, onProgress: ({ rows, characters }) => step("moves", "run", `${rows} rows, ${characters} characters`) });
  } catch (err) {
    step("moves", "fail", err.message);
    throw err;
  }
  const moveCount = [...after.values()].reduce((n, m) => n + m.length, 0);
  step("moves", "done", `${moveCount} moves, ${after.size} characters`);
  // extra sources; each keeps its previous file when a fetch comes back (nearly) empty
  const chars = [...after.keys()];
  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])); // stable diffs
  const sources = [
    { id: "punishers", name: "punishers (Wavu)", file: p.punishersPath, fetch: fetchPunishers, opts: { fetchImpl } },
    { id: "combos", name: "combos (Wavu)", file: p.combosPath, fetch: fetchCombos, opts: { fetchImpl } },
    { id: "tags", name: "tags (TekkenDocs)", file: p.tdTagsPath, fetch: fetchTekkenDocsTags, opts: { fetchImpl: fetchImpl ?? fetch } },
    { id: "stances", name: "stances (Wavu)", file: p.stancesPath ?? path.join(p.repoDir, "data", "wavu", "t8-stances.json"), fetch: fetchStances, opts: { fetchImpl } },
    { id: "guides", name: "guides (Wavu)", file: p.guidesPath ?? path.join(p.repoDir, "data", "wavu", "t8-guides.json"), fetch: fetchGuides, opts: { fetchImpl } },
  ];
  const extras = [];
  for (const src of sources) {
    step(src.id, "run", `0/${chars.length}`);
    const { data, report } = await src.fetch(chars, { ...src.opts, withReport: true, onProgress: (e) => step(src.id, "run", counter(e)) });
    const old = fs.existsSync(src.file) ? fs.readFileSync(src.file, "utf8") : "";
    // Guides have uneven coverage: one useful page is a valid update. Keep previous good
    // pages when other pages/characters fail or return a template-only response.
    const enough = Object.keys(data).length >= (src.id === "guides" ? 1 : 20);
    let next = data;
    if (src.id === "guides" && enough) {
      let previous = {};
      try { previous = JSON.parse(old || "{}"); } catch { /* damaged optional snapshot */ }
      next = mergeGuideSnapshots(previous, data, report);
    }
    if (src.id === "stances" && enough) {
      // a page that failed to load keeps its previous stance names
      let previous = {};
      try { previous = JSON.parse(old || "{}"); } catch { /* damaged optional snapshot */ }
      next = { ...data, ...Object.fromEntries(report.errors.filter((c) => previous[c]).map((c) => [c, previous[c]])) };
    }
    const fresh = enough ? `${JSON.stringify(sorted(next), null, 2)}\n` : old;
    const changed = fresh !== old;
    step(src.id, enough && !report.errors.length ? "done" : "warn", `${reportText(report, { kept: !enough })}${changed ? " · changed" : ""}`);
    extras.push({ ...src, data, report, old, fresh, changed });
  }
  const punishersChanged = extras.some((x) => x.changed);
  step("save", "run", "checking");
  if (!force) {
    try {
      assertPlausible(before, after);
    } catch (err) {
      step("save", "fail", err.message);
      throw err;
    }
  }
  const changes = diffSnapshots(before, after);
  const totals = { characters: after.size, moves: [...after.values()].reduce((n, m) => n + m.length, 0) };
  const audit = auditSnapshots(after);
  const digest = diffFrames(before, after);
  const warn = summarizeAudit(audit);
  const sourcesNote = () => {
    const ch = extras.filter((x) => x.changed).map((x) => x.name);
    return ch.length ? ` Also updated: ${ch.join(", ")}.` : "";
  };
  const withWarn = (msg) => `${msg}${sourcesNote()}${warn ? `\n\n${warn}` : ""}`;

  if (changes.length === 0 && !punishersChanged) {
    step("save", "done", "no changes, nothing to commit");
    const meta = readMeta(p.dataDir);
    return { changed: false, changes, totals, audit, digest, message: withWarn(`No changes in Wavu data since ${meta?.syncedAt ?? "last sync"} (${totals.moves} moves, ${totals.characters} characters).`) };
  }
  if (dryRun) {
    step("save", "skip", `dry run: ${changes.length} character(s) would change`);
    return { changed: true, changes, totals, audit, digest, message: withWarn(`Dry run — ${changes.length} character(s) would change: ${summarize(changes)}`) };
  }

  const syncedAt = new Date().toISOString();
  const rel = path.relative(p.repoDir, p.dataDir);
  for (const x of extras) {
    if (!x.changed) continue;
    fs.mkdirSync(path.dirname(x.file), { recursive: true });
    fs.writeFileSync(x.file, x.fresh);
  }
  writeSnapshots(p.dataDir, after, { source: "https://wavu.wiki (Cargo table Move)", license: "CC BY-SA 4.0", game: "T8", syncedAt, ...totals });
  step("save", "run", "building index");
  try {
    rebuild(p); // validates the new data before anything is committed
  } catch (err) {
    step("save", "fail", `index build failed, data restored`);
    await git(p.repoDir, "checkout", "--", rel).catch(() => {});
    await git(p.repoDir, "clean", "-fdq", "--", rel).catch(() => {});
    for (const x of extras) {
      if (!x.changed) continue;
      if (x.old) fs.writeFileSync(x.file, x.old);
      else fs.rmSync(x.file, { force: true });
    }
    throw new Error(`index build failed, data restored: ${err.message}`);
  }
  step("save", "run", "committing");
  await git(p.repoDir, "add", "--all", "--", rel, ...extras.map((x) => path.relative(p.repoDir, x.file)).filter((f) => fs.existsSync(path.join(p.repoDir, f))));
  const changedSources = extras.filter((x) => x.changed).map((x) => x.name.split(" ")[0]);
  const subject = changes.length
    ? `data: wavu sync ${syncedAt.slice(0, 10)} (${changes.length} chars changed${changedSources.length ? ` + ${changedSources.join(", ")}` : ""})`
    : `data: sources sync ${syncedAt.slice(0, 10)} (${changedSources.join(", ")})`;
  await git(p.repoDir, "commit", "--quiet", "-m", subject, "-m", summarize(changes, 100));
  const commit = await git(p.repoDir, "rev-parse", "--short", "HEAD");
  step("save", "done", `${changes.length} character(s) changed${changedSources.length ? ` + ${changedSources.join(", ")}` : ""} · commit ${commit}`);
  const revertHint = warn ? `\nTo undo: git revert ${commit}, then /fd_rebuild.` : "";
  const what = changes.length ? `${changes.length} character(s) changed: ${summarize(changes)}.` : "Frame data unchanged.";
  return { changed: true, changes, totals, commit, audit, digest, message: withWarn(`Synced ${totals.moves} moves. ${what} Commit ${commit}.`) + revertHint };
}

export async function headCommit(repoDir) {
  return git(repoDir, "rev-parse", "HEAD");
}

export async function lastDataCommit(repoDir, dataDir) {
  try {
    return await git(repoDir, "log", "-1", "--format=%h %cs %s", "--", path.relative(repoDir, dataDir));
  } catch {
    return "";
  }
}
