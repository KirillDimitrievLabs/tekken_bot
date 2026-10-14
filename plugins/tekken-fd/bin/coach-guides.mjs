#!/usr/bin/env node
// Explicit, one-shot guide collection. Normal future updates run through /fd_sync.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchGuides, guideCoverage, mergeGuideSnapshots } from "../src/guides.js";

const repoDir = process.argv[2] ?? fileURLToPath(new URL("../../..", import.meta.url));
const dataDir = path.join(repoDir, "data/wavu/t8");
const characters = fs.readdirSync(dataDir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).map((f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8")).character).sort();
const file = path.join(repoDir, "data/wavu/t8-guides.json");
let previous = {};
try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
const { data, report } = await fetchGuides(characters, { withReport: true, onProgress: ({ done, total, character, status }) => console.log(`${done}/${total} ${character}: ${status}`) });
const combined = mergeGuideSnapshots(previous, data, report);
if (!Object.keys(combined).length) throw new Error("No useful guides returned; previous snapshot preserved.");
fs.writeFileSync(`${file}.tmp-${process.pid}`, `${JSON.stringify(combined, null, 2)}\n`);
fs.renameSync(`${file}.tmp-${process.pid}`, file);
console.log(JSON.stringify({ report, coverage: Object.fromEntries(characters.map((c) => [c, guideCoverage(combined[c])])) }, null, 2));
