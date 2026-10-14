#!/usr/bin/env node
// Server-side CLI (same pipeline as the /fd_* commands):
//   node bin/fd.mjs sync [--dry] [--force] | rebuild | check | audit
// Env: FD_REPO_DIR (default /opt/clan-bots), FD_STATE_DIR (default $OPENCLAW_STATE_DIR/tekken-fd)
import fs from "node:fs";
import path from "node:path";
import { paths, rebuild, sync } from "../src/sync.js";
import { readSnapshots } from "../src/snapshot.js";
import { auditSnapshots, summarizeAudit } from "../src/audit.js";
import { checkOnce, writeState } from "../src/watcher.js";

const [cmd = "help", ...flags] = process.argv.slice(2);
const repoDir = process.env.FD_REPO_DIR ?? "/opt/clan-bots";
const stateDir = process.env.FD_STATE_DIR
  ?? path.join(process.env.OPENCLAW_STATE_DIR ?? path.join(process.env.HOME ?? "/home/node", ".openclaw"), "tekken-fd");
fs.mkdirSync(stateDir, { recursive: true });
const p = paths(repoDir, stateDir);

try {
  if (cmd === "sync") {
    const r = await sync(p, { dryRun: flags.includes("--dry"), force: flags.includes("--force") });
    if (!flags.includes("--dry")) {
      if (!fs.existsSync(p.dbPath)) rebuild(p);
      const now = new Date().toISOString();
      writeState(p.statePath, { pendingCharacters: [], lastSyncAt: now, lastWatchCheck: now });
    }
    console.log(r.message);
  } else if (cmd === "rebuild") {
    const r = rebuild(p);
    console.log(`Index rebuilt: ${r.moves} moves, ${r.characters} characters → ${p.dbPath}`);
  } else if (cmd === "audit") {
    const r = auditSnapshots(readSnapshots(p.dataDir));
    console.log(summarizeAudit(r, 50) || `✅ No unparsed markup in ${r.moves} moves.`);
  } else if (cmd === "check") {
    const characters = [...readSnapshots(p.dataDir).keys()];
    const r = await checkOnce({ statePath: p.statePath, characters, ownerChatId: null });
    console.log(r.characters.length ? `Edited since ${r.since}: ${r.characters.join(", ")}` : `No edits since ${r.since}`);
  } else {
    console.log("usage: fd.mjs sync [--dry] [--force] | rebuild | check | audit");
    process.exitCode = cmd === "help" ? 0 : 2;
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
}
