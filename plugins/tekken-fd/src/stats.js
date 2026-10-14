// Aggregate usage counters for /fd_stats. No message text is stored except unknown character words.
import fs from "node:fs";

const DAYS_KEPT = 30;
const today = () => new Date().toISOString().slice(0, 10);
const bump = (obj, key, n = 1) => {
  if (key) obj[key] = (obj[key] ?? 0) + n;
};
const top = (obj, n) => Object.entries(obj ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n);

export class Stats {
  constructor(file) {
    this.file = file;
    this.data = this.load();
    this.dirty = false;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return { since: new Date().toISOString(), days: {}, total: { outcomes: {}, characters: {}, moves: {}, unknown: {}, model: { count: 0, ms: 0 } } };
    }
  }

  /**
   * @param {string} outcome card | suggest | model | unknown | punish | unsafe | list | help | usage | button
   * @param {{character?: string, moveId?: string, unknown?: string, modelMs?: number}} [info]
   */
  record(outcome, info = {}) {
    const d = (this.data.days[today()] ??= { outcomes: {} });
    bump(d.outcomes, outcome);
    const t = this.data.total;
    bump(t.outcomes, outcome);
    bump(t.characters, info.character);
    bump(t.moves, info.moveId);
    if (info.unknown) bump(t.unknown, info.unknown.toLowerCase().slice(0, 30));
    if (typeof info.modelMs === "number") {
      t.model.count++;
      t.model.ms += info.modelMs;
    }
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    const days = Object.keys(this.data.days).sort();
    for (const d of days.slice(0, Math.max(0, days.length - DAYS_KEPT))) delete this.data.days[d];
    fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
    this.dirty = false;
  }

  format() {
    const t = this.data.total;
    const day = this.data.days[today()]?.outcomes ?? {};
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    const fmt = (o) => top(o, 12).map(([k, v]) => `${k} ${v}`).join(" · ") || "—";
    const lookups = (t.outcomes.card ?? 0) + (t.outcomes.suggest ?? 0) + (t.outcomes.model ?? 0) + (t.outcomes.unknown ?? 0);
    const modelShare = lookups ? Math.round(((t.outcomes.model ?? 0) / lookups) * 100) : 0;
    const avgModel = t.model.count ? (t.model.ms / t.model.count / 1000).toFixed(1) : "—";
    return [
      `📊 tekken-fd stats (since ${this.data.since.slice(0, 10)})`,
      `Today (${sum(day)}): ${fmt(day)}`,
      `All time (${sum(t.outcomes)}): ${fmt(t.outcomes)}`,
      `Model used for ${modelShare}% of !fd lookups, avg ${avgModel}s`,
      `Top moves: ${top(t.moves, 10).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`,
      `Top characters: ${top(t.characters, 10).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`,
      `Unknown character words: ${top(t.unknown, 10).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`,
    ].join("\n");
  }
}
