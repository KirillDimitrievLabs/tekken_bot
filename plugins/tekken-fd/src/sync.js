// Sync pipeline: Wavu → snapshots (git) → SQLite index.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { auditSnapshots, summarizeAudit } from "./audit.js";
import { buildDatabase } from "./db.js";
import { diffFrames } from "./digest.js";
import { assertPlausible, diffSnapshots, readMeta, readSnapshots, writeSnapshots } from "./snapshot.js";
import { fetchAllMoves, fetchCombos, fetchPunishers, fetchTekkenDocsTags } from "./wavu.js";
import fs from "node:fs";

const run = promisify(execFile);

export function paths(repoDir, stateDir) {
  return {
    repoDir,
    dataDir: path.join(repoDir, "data", "wavu", "t8"),
    punishersPath: path.join(repoDir, "data", "wavu", "t8-punishers.json"),
    combosPath: path.join(repoDir, "data", "wavu", "t8-combos.json"),
    tdTagsPath: path.join(repoDir, "data", "tekkendocs", "t8-tags.json"),
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
 * @param {{dryRun?: boolean, force?: boolean}} opts
 * @returns {Promise<{changed: boolean, changes: object[], commit?: string, totals: object, message: string}>}
 */
export async function sync(p, { dryRun = false, force = false, fetchImpl } = {}) {
  const before = readSnapshots(p.dataDir);
  const after = await fetchAllMoves({ fetchImpl });
  // extra sources; each keeps its previous file when a fetch comes back (nearly) empty
  const chars = [...after.keys()];
  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])); // stable diffs
  const extras = [
    { name: "punishers (Wavu)", file: p.punishersPath, data: await fetchPunishers(chars, { fetchImpl }), min: 20 },
    { name: "combos (Wavu)", file: p.combosPath, data: await fetchCombos(chars, { fetchImpl }), min: 20 },
    { name: "tags (TekkenDocs)", file: p.tdTagsPath, data: await fetchTekkenDocsTags(chars, { fetchImpl: fetchImpl ?? fetch }), min: 20 },
  ].map((x) => {
    const old = fs.existsSync(x.file) ? fs.readFileSync(x.file, "utf8") : "";
    const fresh = Object.keys(x.data).length >= x.min ? `${JSON.stringify(sorted(x.data), null, 2)}\n` : old;
    return { ...x, old, fresh, changed: fresh !== old };
  });
  const punishersChanged = extras.some((x) => x.changed);
  if (!force) assertPlausible(before, after);
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
    const meta = readMeta(p.dataDir);
    return { changed: false, changes, totals, audit, digest, message: withWarn(`No changes in Wavu data since ${meta?.syncedAt ?? "last sync"} (${totals.moves} moves, ${totals.characters} characters).`) };
  }
  if (dryRun) {
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
  try {
    rebuild(p); // validates the new data before anything is committed
  } catch (err) {
    await git(p.repoDir, "checkout", "--", rel).catch(() => {});
    await git(p.repoDir, "clean", "-fdq", "--", rel).catch(() => {});
    throw new Error(`index build failed, data restored: ${err.message}`);
  }
  await git(p.repoDir, "add", "--all", "--", rel, ...extras.map((x) => path.relative(p.repoDir, x.file)).filter((f) => fs.existsSync(path.join(p.repoDir, f))));
  const subject = `data: wavu sync ${syncedAt.slice(0, 10)} (${changes.length} chars changed)`;
  await git(p.repoDir, "commit", "--quiet", "-m", subject, "-m", summarize(changes, 100));
  const commit = await git(p.repoDir, "rev-parse", "--short", "HEAD");
  const revertHint = warn ? `\nTo undo: git revert ${commit}, then /fd_rebuild.` : "";
  return { changed: true, changes, totals, commit, audit, digest, message: withWarn(`Synced ${totals.moves} moves. ${changes.length} character(s) changed: ${summarize(changes)}. Commit ${commit}.`) + revertHint };
}

export async function lastDataCommit(repoDir, dataDir) {
  try {
    return await git(repoDir, "log", "-1", "--format=%h %cs %s", "--", path.relative(repoDir, dataDir));
  } catch {
    return "";
  }
}
