// Live /fd_sync progress: one message edited in place as each step advances.

export const SYNC_STEPS = [
  ["moves", "Wavu frame data"],
  ["punishers", "Wavu punishers"],
  ["combos", "Wavu combos"],
  ["tags", "TekkenDocs tags"],
  ["save", "Check, index & commit"],
  ["push", "GitHub push"],
];

const ICON = { wait: "▫️", run: "🔄", done: "✅", warn: "⚠️", fail: "❌", skip: "➖" };

/**
 * @param {string} title
 * @param {[string, string][]} steps  [id, label]
 * @param {{show?: (text: string) => Promise<void>, minIntervalMs?: number, now?: () => number}} opts
 *   show() posts/edits the message; it is called serially, at most every minIntervalMs while a step runs.
 */
export class ProgressBoard {
  constructor(title, steps, { show = async () => {}, minIntervalMs = 2500, now = Date.now } = {}) {
    this.title = title;
    this.steps = steps.map(([id, label]) => ({ id, label, state: "wait", detail: "" }));
    this.show = show;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.started = now();
    this.footer = "";
    this.lastShown = 0;
    this.chain = Promise.resolve();
    this.timer = null;
  }

  step(id) {
    return this.steps.find((s) => s.id === id);
  }

  /** state: wait | run | done | warn | fail | skip */
  update(id, state, detail = "") {
    const s = this.step(id);
    if (!s) return this.chain;
    s.state = state;
    s.detail = detail;
    return this.flush(state !== "run");
  }

  /** Mark every step still waiting/running as skipped (e.g. after a failure or a dry run). */
  skipRest(detail = "") {
    for (const s of this.steps) if (s.state === "wait" || s.state === "run") Object.assign(s, { state: "skip", detail });
  }

  finish(footer) {
    this.footer = footer;
    return this.flush(true);
  }

  text() {
    const secs = Math.round((this.now() - this.started) / 1000);
    const lines = [`${this.title} · ${secs}s`];
    for (const s of this.steps) lines.push(`${ICON[s.state]} ${s.label}${s.detail ? ` — ${s.detail}` : ""}`);
    if (this.footer) lines.push("", this.footer);
    return lines.join("\n");
  }

  flush(force = false) {
    const wait = this.lastShown + this.minIntervalMs - this.now();
    if (!force && wait > 0) {
      // throttled: show the latest state once the interval has passed
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush(true);
        }, wait);
        this.timer.unref?.();
      }
      return this.chain;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastShown = this.now();
    const text = this.text();
    this.chain = this.chain.then(() => this.show(text)).catch(() => {});
    return this.chain;
  }
}

/** "12/35 · Kazuya" */
export const counter = ({ done, total, character }) => `${done}/${total}${character ? ` · ${character}` : ""}`;

/** Summary of a per-character fetch report: "33 ok, 2 without a page" / "⚠️ failed: X, Y". */
export function reportText(report, { kept = false } = {}) {
  const parts = [`${report.ok} characters`];
  if (report.missing.length) parts.push(`${report.missing.length} with no data`);
  if (report.errors.length) parts.push(`failed: ${report.errors.slice(0, 6).join(", ")}${report.errors.length > 6 ? ` +${report.errors.length - 6}` : ""}`);
  if (kept) parts.push("too little data, kept previous file");
  return parts.join(", ");
}
