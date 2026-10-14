// B4: !whiff <B> <move> [as A] — whiff-punish window from Wavu recovery/total frames (approximate: range).
import { cleanInline } from "./format.js";
import { punishOptions } from "./queries.js";
import { b, code, mk, esc } from "./render.js";
import { prettyKey } from "./stances.js";

export function formatWhiff(index, a, target, limit = 6) {
  const recv = target.recv_n;
  const head = `🌬 ${b(`Whiff punish ${target.character} ${prettyKey(target.character, target.key)}`)}`;
  if (!recv) return `${head}\nNo recovery data for this move.`;
  const stats = `recovery ${esc(cleanInline(target.recv))}${target.tot_n ? ` · total ${target.tot_n}` : ""} · block ${esc(cleanInline(target.block) || "—")}`;
  // moves A can start within the recovery window; longer reach first when known, then launch/damage
  const opts = punishOptions(index, a, "standing", recv);
  const withReach = opts.map((o) => {
    const row = index.where(a, "key = ?", [o.key])[0];
    return { ...o, reach: row?.reach_n ?? null };
  });
  withReach.sort((x, y) => (y.reach ?? -1) - (x.reach ?? -1) || Number(y.launcher) - Number(x.launcher) || y.damage - x.damage);
  const lines = withReach.slice(0, limit).map((o) => `i${o.startup} ${mk(a, o.key)} — ${o.damage} dmg${o.launcher ? " 🚀" : ""}${o.reach ? ` · reach ${o.reach}` : ""}`);
  return [
    head,
    stats,
    b(`${a}: moves that start within ${recv}f`),
    lines.length ? lines.join("\n") : "none that fast",
    "<i>≈ Whether it reaches depends on distance; reach is known for few moves.</i>",
  ].join("\n");
}
