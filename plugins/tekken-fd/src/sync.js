// Sync pipeline: Wavu → snapshots (git) → SQLite index.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { auditSnapshots, summarizeAudit } from "./audit.js";
import { buildDatabase } from "./db.js";
import { diffFrames } from "./digest.js";
import { assertPlausible, diffSnapshots, readMeta, readSnapshots, writeSnapshots } from "./snapshot.js";
import { fetchAllMoves, fetchPunishers } from "./wavu.js";
import fs from "node:fs";

const run = promisify(execFile);

export function paths(repoDir, stateDir) {
  return {
    repoDir,
    dataDir: path.join(repoDir, "data", "wavu", "t8"),
    punishersPath: path.join(repoDir, "data", "wavu", "t8-punishers.json"),
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
  let punishers = {};
  try {
    punishers = JSON.parse(fs.readFileSync(p.punishersPath, "utf8"));
  } catch {
    // no curated punishers yet: computed punishers only
  }
  buildDatabase(p.dbPath, snapshots, { syncedAt: meta.syncedAt ?? "", source: "wavu.wiki" }, punishers);
  return { characters: snapshots.size, moves: [...snapshots.values()].reduce((n, m) => n + m.length, 0) };
}

/**
 * @param {{dryRun?: boolean, force?: boolean}} opts
 * @returns {Promise<{changed: boolean, changes: object[], commit?: string, totals: object, message: string}>}
 */
export async function sync(p, { dryRun = false, force = false, fetchImpl } = {}) {
  const before = readSnapshots(p.dataDir);
  const after = await fetchAllMoves({ fetchImpl });
  // curated punishers (Wavu "<Character> punishers"); keep the old file if the fetch came back empty
  const punishers = await fetchPunishers([...after.keys()], { fetchImpl });
  const oldPunishers = fs.existsSync(p.punishersPath) ? fs.readFileSync(p.punishersPath, "utf8") : "";
  const newPunishers = Object.keys(punishers).length >= 20 ? `${JSON.stringify(punishers, null, 2)}\n` : oldPunishers;
  const punishersChanged = newPunishers !== oldPunishers;
  if (!force) assertPlausible(before, after);
  const changes = diffSnapshots(before, after);
  const totals = { characters: after.size, moves: [...after.values()].reduce((n, m) => n + m.length, 0) };
  const audit = auditSnapshots(after);
  const digest = diffFrames(before, after);
  const warn = summarizeAudit(audit);
  const withWarn = (msg) => (warn ? `${msg}\n\n${warn}` : msg);

  if (changes.length === 0 && !punishersChanged) {
    const meta = readMeta(p.dataDir);
    return { changed: false, changes, totals, audit, digest, message: withWarn(`No changes in Wavu data since ${meta?.syncedAt ?? "last sync"} (${totals.moves} moves, ${totals.characters} characters).`) };
  }
  if (dryRun) {
    return { changed: true, changes, totals, audit, digest, message: withWarn(`Dry run — ${changes.length} character(s) would change: ${summarize(changes)}`) };
  }

  const syncedAt = new Date().toISOString();
  const rel = path.relative(p.repoDir, p.dataDir);
  if (punishersChanged && !dryRun) fs.writeFileSync(p.punishersPath, newPunishers);
  writeSnapshots(p.dataDir, after, { source: "https://wavu.wiki (Cargo table Move)", license: "CC BY-SA 4.0", game: "T8", syncedAt, ...totals });
  try {
    rebuild(p); // validates the new data before anything is committed
  } catch (err) {
    await git(p.repoDir, "checkout", "--", rel).catch(() => {});
    await git(p.repoDir, "clean", "-fdq", "--", rel).catch(() => {});
    throw new Error(`index build failed, data restored: ${err.message}`);
  }
  await git(p.repoDir, "add", "--all", "--", rel, path.relative(p.repoDir, p.punishersPath));
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
