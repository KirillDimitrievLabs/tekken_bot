import fs from "node:fs";
import path from "node:path";
import { buildDossier } from "./dossier.js";
import { CoachCache, cacheKey } from "./cache.js";
import { buildPrompt, PROMPT_VERSION } from "./prompt.js";
import { validateGuide } from "./validate.js";
import { renderGuide, renderFallback } from "./render.js";

const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
const DOSSIER_MEMO = 24;
export const COACH_MODELS = ["openai/gpt-6-astra", "openai/gpt-6.1-sol", "openai/gpt-6-sol"];

/** No scheduled work: generation starts only from an authorized command or button. */
export class Coach {
  constructor({ index, repoDir, stateDir, complete, tips, config = {}, logger = {}, now = Date.now }) {
    this.index = index;
    this.repoDir = repoDir;
    this.complete = complete;
    this.tips = tips;
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.cache = new CoachCache(path.join(stateDir, "coach.sqlite"), { now });
    this.pending = new Map();
    this.active = 0;
    this.waiters = [];
    this.resources = new Map();
    this.dossiers = new Map();
    this.closed = false;
  }
  guidesFile() { return path.join(this.repoDir, "data/wavu/t8-guides.json"); }
  guides() { return read(this.guidesFile()); }
  /**
   * Building a dossier takes 0.4–0.8 s of synchronous work, so it is memoised by everything it
   * depends on: target, index data version, guide file version and the approved tips.
   */
  dossier(target) {
    const tips = this.tips?.approved(target.as, target.opponent) ?? [];
    const stamp = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
    const key = JSON.stringify([target.as ?? null, target.opponent, target.language ?? null, target.level ?? null,
      this.index.meta?.()?.syncedAt ?? "", stamp(this.guidesFile()), tips]);
    const hit = this.dossiers.get(key);
    if (hit) {
      this.dossiers.delete(key); // LRU: move to the end
      this.dossiers.set(key, hit);
      return hit;
    }
    const built = buildDossier(this.index, { ...target, guides: this.guides(), tips });
    this.dossiers.set(key, built);
    while (this.dossiers.size > DOSSIER_MEMO) this.dossiers.delete(this.dossiers.keys().next().value);
    return built;
  }
  /** Data, tips or index changed: forget memoised dossiers and cached guides. */
  invalidate() {
    this.dossiers.clear();
    this.cache.invalidate();
  }
  model(mode) {
    const m = this.config.models?.[mode] ?? this.config.model ?? "openai/gpt-6.1-sol";
    if (!COACH_MODELS.includes(m)) throw new Error("Unknown coach model.");
    return m;
  }
  keyFor(target, dossier = this.dossier(target), model = this.model(dossier.mode)) {
    return cacheKey({ ...target, mode: dossier.mode, dossierHash: dossier.hash, tipsHash: dossier.tipsHash, promptVersion: PROMPT_VERSION, model });
  }
  async acquire() {
    if (this.active < 2) { this.active++; return; }
    if (this.waiters.length >= 20) throw new Error("Coach is busy. Try again shortly.");
    await new Promise((resolve) => this.waiters.push(resolve));
  }
  release() { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  fallback(dossier, reason) {
    return { fallback: true, reason, dossier, parts: renderFallback(this.index, dossier, reason), key: null };
  }
  async generate(target, { userId, force = false, admin = false, progress = () => {}, modelOverride = null } = {}) {
    if (this.closed) throw new Error("Coach is stopping.");
    const dossier = this.dossier(target);
    const model = modelOverride ?? this.model(dossier.mode);
    if (!COACH_MODELS.includes(model) || (modelOverride && !admin)) throw new Error("Owner-only evaluation model.");
    const key = this.keyFor(target, dossier, model);
    if (force && !admin) throw new Error("Only an admin can regenerate a guide.");
    if (force) this.cache.delete(key);
    if (!force) {
      const hit = this.cache.get(key);
      if (hit) return { ...hit, parts: renderGuide(this.index, hit.guide, dossier, { model, createdAt: hit.created_at }), key, dossier, cached: true };
    }
    // Dedupe before charging the user: waiters do not create another model call.
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= 20) throw new Error("Coach is busy. Try again shortly.");
    if (typeof this.complete !== "function") return this.fallback(dossier, "Model runtime is unavailable; showing indexed facts.");
    const charged = !admin;
    if (charged && !this.cache.consume(userId)) throw new Error("Daily limit: 5 new guides. Cached guides remain available. Resets at 00:00 UTC.");
    const job = this.build(dossier, target, { model, key, progress });
    this.pending.set(key, job);
    let result;
    try {
      result = await job;
    } catch (err) {
      if (charged) this.cache.refund(userId);
      throw err;
    } finally {
      this.pending.delete(key);
    }
    // Only a delivered guide counts against the daily limit; fallbacks are free.
    if (charged && result?.fallback) this.cache.refund(userId);
    return result;
  }
  async build(dossier, target, { model, key, progress }) {
    progress("dossier", "run", "queued; preparing source facts");
    // Different language/level variants must keep their own output while sharing a pair lock.
    const resource = JSON.stringify([dossier.as, dossier.opponent]);
    const previous = this.resources.get(resource);
    let unlock;
    const held = new Promise((resolve) => { unlock = resolve; });
    this.resources.set(resource, held);
    const started = this.now();
    let ticker;
    let acquired = false;
    try {
      if (previous) await previous;
      await this.acquire();
      acquired = true;
      if (this.closed) throw new Error("Coach is stopping.");
      progress("dossier", "done", `${dossier.opponent} · ${dossier.coverage?.level ?? "sparse"}`);
      progress("model", "run", `${model}, high`);
      ticker = setInterval(() => progress("model", "run", `${model}, high · ${Math.round((this.now() - started) / 1000)}s`), 5000);
      ticker.unref?.();
      const prompt = buildPrompt(dossier, target);
      let problems = [];
      let validation;
      for (let attempt = 0; attempt < 2; attempt++) {
        const messages = [{ role: "user", content: `${prompt.messages[0].content}${attempt ? `\n\nPrevious output failed validation. Generate a complete corrected object. Fix these problems:\n${problems.join("\n")}` : ""}` }];
        const response = await this.complete({ systemPrompt: prompt.systemPrompt, messages, model, reasoning: "high", temperature: 0.3,
          purpose: "tekken-fd.coach", maxTokens: 6000, execution: { mode: "isolated-agent-runtime", timeoutMs: 180000 } });
        progress("check", "run", attempt ? "corrective retry" : "validate facts and move references");
        validation = validateGuide(response?.text ?? response?.content ?? response, dossier);
        if (validation.strippedNumbers?.length) this.logger.warn?.(`coach numeric rejection: ${JSON.stringify(validation.strippedNumbers)}`);
        if (validation.ok) break;
        problems = validation.errors.slice(0, 30);
        this.logger.warn?.(`coach validation attempt ${attempt + 1}: ${problems.join("; ")}`);
      }
      if (!validation?.ok) return this.fallback(dossier, "The guide failed fact checks after a retry; showing indexed facts.");
      // A sync or approval can occur while the model thinks. Never deliver stale advice.
      const current = this.dossier(target);
      if (current.hash !== dossier.hash || current.tipsHash !== dossier.tipsHash) return this.fallback(current, "Data changed during generation. Request the guide again.");
      const createdAt = new Date(this.now()).toISOString();
      const parts = renderGuide(this.index, validation.guide, dossier, { model, createdAt });
      this.cache.put(key, { guide: validation.guide, parts, model, as: target.as, opponent: target.opponent });
      progress("check", "done", "validated");
      return { guide: validation.guide, dossier, parts, model, key, createdAt, cached: false, latencyMs: this.now() - started };
    } catch (err) {
      this.logger.warn?.(`coach generation failed (${err.code ?? "completion"}): ${err.message}`);
      return this.fallback(this.dossier(target), "The model could not finish; showing indexed facts.");
    } finally {
      clearInterval(ticker); if (acquired) this.release(); unlock();
      if (this.resources.get(resource) === held) this.resources.delete(resource);
    }
  }
  async close() { this.closed = true; await Promise.allSettled([...this.pending.values()]); this.cache.close(); }
}
