// Moderated clan knowledge. Only public, approved records enter git; identities and votes stay in state.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { looseKey, strictKey } from "./notation.js";

const run = promisify(execFile);
export const TIP_CATEGORIES = ["defense", "punish", "neutral", "pressure", "wall", "heat", "oki", "general"];
const copy = (value) => structuredClone(value);
const emptyState = () => ({ version: 1, seq: 0, tips: {}, votes: {} });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback(); throw new Error(`Cannot read tips storage: ${path.basename(file)} (${error.message})`); }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`;
  let handle;
  try {
    handle = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
    fs.closeSync(handle); handle = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    fs.rmSync(temp, { force: true });
  }
}

function displayName(author, userId) {
  const name = String(author ?? "Clan member").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return !name || name === String(userId) || /^(?:telegram:|tg:\/\/user\?id=)\d+$/i.test(name) ? "Clan member" : name;
}

/** Explicit whitelist: no private state field can accidentally escape into git or a dossier. */
function publicTip(tip) {
  const out = Object.fromEntries(["id", "game", "opponent", "as", "category", "text", "moves", "author", "dataVersion", "createdAt", "approvedAt"].map((key) => [key, tip[key] ?? null]));
  out.status = "approved";
  if (tip.needsReview || tip.status === "needsReview") out.needsReview = true;
  if (out.needsReview && tip.reviewReason) out.reviewReason = String(tip.reviewReason).slice(0, 400);
  return out;
}

const normalizedText = (text) => String(text).toLowerCase().replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
const trigrams = (text) => {
  const value = `  ${normalizedText(text)}  `;
  return new Set(Array.from({ length: Math.max(0, value.length - 2) }, (_, i) => value.slice(i, i + 3)));
};

export function tipSimilarity(a, b) {
  const left = trigrams(a), right = trigrams(b);
  const same = [...left].filter((item) => right.has(item)).length;
  return left.size + right.size ? (2 * same) / (left.size + right.size) : 1;
}

export function inferTipCategory(text) {
  const rules = [
    ["heat", /\bheat\b|хит(?:а|е|ом)?\b/iu], ["wall", /\bwall\b|стен/iu],
    ["oki", /\b(?:oki|okizeme|wake.?up|grounded)\b|окиземе|подъ[её]м/iu],
    ["punish", /\bpunish|наказ/iu], ["defense", /\b(?:duck|block|sidestep|ssl|ssr|interrupt|defen[cs]e)\b|пригни|блок|защит|прерв/iu],
    ["pressure", /\b(?:pressure|plus|frame trap|mix.?up)\b|давлен|микс/iu],
    ["neutral", /\b(?:neutral|whiff|spacing|range|backdash)\b|нейтрал|дистанц|вифф/iu],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] ?? "general";
}

function category(value, text) {
  if (value == null || value === "") return inferTipCategory(text);
  const result = String(value).replace(/^#/, "").toLowerCase();
  if (!TIP_CATEGORIES.includes(result)) throw new Error(`Category must be one of: ${TIP_CATEGORIES.join(", ")}`);
  return result;
}

const escaped = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Resolve notation conservatively: ambiguous moves remain literal and are reported in the confirmation. */
export function resolveTipMoves(index, text, { opponent, as = null }) {
  const characters = [...new Set([opponent, as].filter(Boolean))];
  const detected = [], unresolved = [], refs = [];
  const ranges = [];
  let output = String(text).replace(/\[\[([^\]\n]+)\]\]/g, (token, id, offset) => {
    const move = index.move(id);
    if (!move || !characters.includes(move.character)) throw new Error(`Unknown or wrong-character move reference: ${id}`);
    refs.push(id); ranges.push([offset, offset + token.length]);
    detected.push({ input: token, id, key: move.key, character: move.character, startup: move.startup, block: move.block });
    return token;
  });
  if (/\[\[|\]\]/.test(output.replace(/\[\[[^\]\n]+\]\]/g, ""))) throw new Error("Move references must use complete [[move-id]] tokens");
  // Plain ordinal/count numbers are not moves. A lone button is accepted only inside backticks.
  const notation = /`[1-4]`|\b(?:[a-z][a-z0-9]*\.)*(?:(?:(?:df|db|uf|ub|qcf|qcb|hcf|hcb|ws|wr|fc|f|b|d|u|n)[,+.~]*)+\+?[1-4](?:[+,~][1-4])*|[1-4](?:[+,~][1-4])+)(?![a-z0-9])/gi;
  const replacements = [];
  for (const match of output.matchAll(notation)) {
    const start = match.index, end = start + match[0].length;
    if (ranges.some(([a, b]) => start >= a && end <= b)) continue;
    const input = match[0].replace(/`/g, "");
    const prefix = output.slice(0, start);
    const explicit = characters.find((character) => new RegExp(`(?:^|[^a-z0-9])${escaped(character)}\\s+$`, "i").test(prefix));
    const options = explicit ? [explicit] : characters;
    const candidates = new Map();
    for (const character of options) {
      const strict = index.byKey(character, "strict", strictKey(input));
      const moves = strict.length ? strict : index.byKey(character, "loose", looseKey(input));
      for (const move of moves) candidates.set(move.id, move);
    }
    if (candidates.size !== 1) {
      unresolved.push({ input, candidates: [...candidates.values()].map((move) => ({ id: move.id, key: move.key, character: move.character })) });
      continue;
    }
    const move = [...candidates.values()][0];
    replacements.push([start, end, `[[${move.id}]]`]); refs.push(move.id);
    detected.push({ input, id: move.id, key: move.key, character: move.character, startup: move.startup, block: move.block });
  }
  for (const [start, end, replacement] of replacements.reverse()) output = output.slice(0, start) + replacement + output.slice(end);
  return { text: output, moves: [...new Set(refs)], detected, unresolved };
}

export class Tips {
  /** stateDir must be outside repoDir. commit=false is useful only for isolated tests/tools. */
  constructor({ repoDir, stateDir, index, commit, onChange, now = () => new Date() }) {
    this.repoDir = path.resolve(repoDir); this.stateDir = path.resolve(stateDir); this.index = index;
    const relative = path.relative(this.repoDir, this.stateDir);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Private tips stateDir must be outside the repository");
    this.relativePath = "data/tips/t8-tips.json";
    this.file = path.join(this.repoDir, this.relativePath);
    this.stateFile = path.join(this.stateDir, "tips-state.json");
    this.commit = commit; this.onChange = onChange; this.now = now;
    this.mutations = Promise.resolve();
  }

  _date() { return this.now().toISOString(); }
  _state() {
    const data = readJson(this.stateFile, emptyState);
    if (data.version !== 1 || !data.tips || !data.votes) throw new Error("Invalid private tips storage");
    return data;
  }
  _repo() {
    const tips = readJson(this.file, () => []);
    if (!Array.isArray(tips)) throw new Error("Invalid approved tips storage");
    return tips.map(publicTip);
  }
  _save(state) { atomicJson(this.stateFile, state); }
  _locked(fn) {
    const job = this.mutations.then(fn);
    this.mutations = job.catch(() => {});
    return job;
  }
  _characters(opponent, as) {
    const names = this.index.characters().map((item) => typeof item === "string" ? item : item.name);
    for (const character of [opponent, as].filter(Boolean)) if (!names.includes(character)) throw new Error(`Unknown character: ${character}`);
    if (!opponent) throw new Error("Opponent character is required");
  }
  _text(text, opponent, as) {
    const raw = String(text ?? "").trim();
    const length = [...raw].length;
    if (length < 20 || length > 400) throw new Error("Tip text must be 20–400 characters");
    return resolveTipMoves(this.index, raw, { opponent, as });
  }
  _duplicate(tip, state, except = null) {
    const tips = [...this._repo(), ...Object.values(state.tips).filter((item) => ["draft", "pending", "needsReview"].includes(item.status))];
    const existing = tips.find((item) => item.id !== except && item.opponent === tip.opponent && (item.as ?? null) === tip.as && tipSimilarity(item.text, tip.text) > 0.8);
    if (existing) throw new Error(`This looks like an existing tip (${existing.id})`);
  }

  draft({ userId, author, opponent, as = null, text, category: chosenCategory, dataVersion }) {
    if (userId == null || String(userId).trim() === "") throw new Error("Tip author is required");
    this._characters(opponent, as);
    const state = this._state(), idOfUser = String(userId);
    if (Object.values(state.tips).filter((item) => item.userId === idOfUser && ["draft", "pending"].includes(item.status)).length >= 5) throw new Error("You already have 5 pending tips; wait for moderation or cancel a draft");
    const parsed = this._text(text, opponent, as);
    const tip = { game: "T8", opponent, as, category: category(chosenCategory, text), ...parsed, rawText: String(text).trim(), author: displayName(author, userId), userId: idOfUser,
      dataVersion: dataVersion ?? `wavu:${String(this.index.meta?.().fetchedAt ?? this.index.meta?.().builtAt ?? this._date()).slice(0, 10)}`, createdAt: this._date(), status: "draft" };
    this._duplicate(tip, state);
    const used = new Set([...Object.keys(state.tips), ...this._repo().map((item) => item.id)]);
    do { state.seq++; tip.id = `t_${String(state.seq).padStart(4, "0")}`; } while (used.has(tip.id));
    state.tips[tip.id] = tip; this._save(state);
    return copy(tip);
  }

  confirm(id, userId) {
    const state = this._state(), tip = state.tips[id];
    if (!tip || tip.userId !== String(userId)) throw new Error("This draft belongs to another user");
    if (tip.status !== "draft") throw new Error("Tip is no longer awaiting confirmation");
    this._characters(tip.opponent, tip.as);
    resolveTipMoves(this.index, tip.text, tip); // Reject references removed since the draft was made.
    this._duplicate(tip, state, id);
    tip.status = "pending"; tip.confirmedAt = this._date(); this._save(state);
    return copy(tip);
  }

  cancel(id, userId) {
    const state = this._state(), tip = state.tips[id];
    if (!tip || tip.userId !== String(userId)) throw new Error("This draft belongs to another user");
    if (tip.status !== "draft") throw new Error("Only an unconfirmed draft can be cancelled");
    tip.status = "cancelled"; this._save(state); return copy(tip);
  }

  get(id) {
    const local = this._state().tips[id], published = this._repo().find((item) => item.id === id);
    return local || published ? copy({ ...published, ...local }) : null;
  }
  queue() { return Object.values(this._state().tips).filter((tip) => ["pending", "needsReview"].includes(tip.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(copy); }
  own(userId) { return Object.values(this._state().tips).filter((tip) => tip.userId === String(userId) && tip.status !== "cancelled").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(copy); }

  /** Public records only: general tips also apply to a specific A vs B request. */
  approved(as, opponent) {
    if (typeof as === "object" && as !== null) ({ as = null, opponent } = as);
    const state = this._state();
    return this._repo().filter((tip) => (!opponent || tip.opponent === opponent) && (tip.as == null || (as != null && tip.as === as)))
      .map((tip) => ({ ...tip, votes: Object.values(state.votes[tip.id] ?? {}).reduce((sum, vote) => sum + vote, 0) }))
      .sort((a, b) => b.votes - a.votes || a.createdAt.localeCompare(b.createdAt));
  }
  hash(as, opponent) { return createHash("sha256").update(JSON.stringify(this.approved(as, opponent))).digest("hex"); }

  async _publish(records, message) {
    const before = this._repo();
    const sorted = records.map(publicTip).sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(before) === JSON.stringify(sorted)) return null;
    atomicJson(this.file, sorted);
    try {
      if (typeof this.commit === "function") return await this.commit({ file: this.file, relativePath: this.relativePath, message });
      if (this.commit === false) return null;
      const git = (...args) => run("git", ["-C", this.repoDir, ...args]);
      await git("add", "--", this.relativePath);
      // --only prevents another feature's staged files from entering this moderation commit.
      await git("commit", "--quiet", "--only", "-m", message, "--", this.relativePath);
      return (await git("rev-parse", "--short", "HEAD")).stdout.trim();
    } catch (error) {
      atomicJson(this.file, before);
      throw new Error(`Tip was not published; commit failed: ${error.message}`);
    }
  }
  _changed(tip, reason) { return this.onChange?.({ as: tip.as, opponent: tip.opponent, id: tip.id, reason }); }

  approve(id) {
    return this._locked(async () => {
      const tip = this.get(id);
      if (!tip || !["pending", "needsReview"].includes(tip.status)) throw new Error("Only queued tips can be approved");
      this._characters(tip.opponent, tip.as); resolveTipMoves(this.index, tip.text, tip);
      const approved = { ...tip, status: "approved", approvedAt: this._date() };
      delete approved.needsReview; delete approved.reviewReason;
      const commit = await this._publish([...this._repo().filter((item) => item.id !== id), approved], `tips: approve ${id}`);
      const state = this._state(); state.tips[id] = approved;
      if (tip.status === "needsReview") state.votes[id] = {}; // Start a new moderation round.
      this._save(state); await this._changed(approved, "approved");
      return { ...copy(approved), commit };
    });
  }

  edit(id, text) {
    return this._locked(async () => {
      const tip = this.get(id);
      if (!tip || !["pending", "approved", "needsReview"].includes(tip.status)) throw new Error("Only submitted tips can be edited");
      const updated = { ...tip, ...this._text(text, tip.opponent, tip.as), rawText: String(text).trim(), editedAt: this._date() };
      this._duplicate(updated, this._state(), id);
      if (this._repo().some((item) => item.id === id)) await this._publish(this._repo().map((item) => item.id === id ? updated : item), `tips: edit ${id}`);
      const state = this._state(); state.tips[id] = updated; this._save(state); await this._changed(updated, "edited");
      return copy(updated);
    });
  }

  setCategory(id, value) {
    return this._locked(async () => {
      const tip = this.get(id);
      if (!tip || !["pending", "approved", "needsReview"].includes(tip.status)) throw new Error("Only submitted tips can be categorized");
      const updated = { ...tip, category: category(value, tip.text) };
      if (updated.category === tip.category) return copy(tip);
      if (this._repo().some((item) => item.id === id)) await this._publish(this._repo().map((item) => item.id === id ? updated : item), `tips: category ${id}`);
      const state = this._state(); state.tips[id] = updated; this._save(state); await this._changed(updated, "category");
      return copy(updated);
    });
  }

  reject(id, reason) {
    return this._locked(async () => {
      const tip = this.get(id);
      if (!tip || !["pending", "needsReview"].includes(tip.status)) throw new Error("Only queued tips can be rejected");
      const explanation = String(reason ?? "").trim();
      if (!explanation || explanation.length > 400) throw new Error("Rejection reason must be 1–400 characters");
      if (this._repo().some((item) => item.id === id)) await this._publish(this._repo().filter((item) => item.id !== id), `tips: reject ${id}`);
      const rejected = { ...tip, status: "rejected", rejectedAt: this._date(), rejectionReason: explanation };
      const state = this._state(); state.tips[id] = rejected; this._save(state); await this._changed(rejected, "rejected");
      return copy(rejected);
    });
  }

  vote(id, userId, value) {
    return this._locked(async () => {
      if (![1, -1].includes(value)) throw new Error("Vote must be +1 or -1");
      if (userId == null || String(userId).trim() === "") throw new Error("Voter is required");
      const publicRecord = this._repo().find((tip) => tip.id === id);
      if (!publicRecord) throw new Error("Only approved tips can receive votes");
      const state = this._state(), votes = state.votes[id] ??= {};
      if (Object.hasOwn(votes, String(userId))) throw new Error("You already voted on this tip");
      votes[String(userId)] = value;
      const net = Object.values(votes).reduce((sum, vote) => sum + vote, 0);
      let tip = { ...publicRecord, ...state.tips[id] };
      if (net <= -3 && !publicRecord.needsReview) {
        tip = { ...tip, status: "needsReview", needsReview: true, reviewReason: "Clan vote total reached −3", reviewAt: this._date() };
        await this._publish(this._repo().map((item) => item.id === id ? tip : item), `tips: review ${id}`);
        state.tips[id] = tip;
      }
      // Reload to preserve drafts confirmed while the git subprocess was running.
      const latest = this._state(); latest.votes[id] = votes;
      if (tip.status === "needsReview") latest.tips[id] = tip;
      this._save(latest); await this._changed(tip, "vote");
      return { id, votes: net, needsReview: Boolean(tip.needsReview), tip: copy(tip) };
    });
  }

  /** Accept diffFrames() output, individual id changes, or a list of such changes. */
  flagChangedMoves(digest) {
    return this._locked(async () => {
      const changes = Array.isArray(digest) ? digest : digest?.changes ?? [];
      const changed = new Map();
      for (const item of changes) {
        if (item.field && !["startup", "block", "hit"].includes(item.field)) continue;
        const id = item.id ?? item.moveId ?? (item.character && item.key ? `${item.character}-${item.key}` : null);
        if (id) changed.set(id, item.field ? `${item.field}: ${item.from ?? "?"} → ${item.to ?? "?"}` : "referenced move changed");
      }
      for (const [character, keys] of Object.entries(digest?.removed ?? {})) for (const key of keys) changed.set(`${character}-${key}`, "referenced move removed");
      const records = this._repo(), affected = [];
      for (const record of records) {
        const moves = record.moves.filter((id) => changed.has(id));
        if (!moves.length) continue;
        const tip = { ...record, ...this._state().tips[record.id], status: "needsReview", needsReview: true, reviewAt: this._date(), reviewReason: moves.map((id) => `${id}: ${changed.get(id)}`).join("; ").slice(0, 400) };
        affected.push(tip);
      }
      if (!affected.length) return [];
      const byId = new Map(affected.map((tip) => [tip.id, tip]));
      await this._publish(records.map((tip) => byId.get(tip.id) ?? tip), `tips: review ${affected.length} after frame update`);
      const state = this._state(); for (const tip of affected) state.tips[tip.id] = tip; this._save(state);
      for (const tip of affected) await this._changed(tip, "frames");
      return affected.map(copy);
    });
  }
}
