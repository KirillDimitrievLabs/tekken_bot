# Tekken coach

The coach uses **openai/gpt-6.1-sol with high reasoning**, as selected by the owner.
No model benchmarks or automatic evaluations are run. Completions are isolated, contain
one user message and have no supplied tools. The runtime owns subscription authentication;
the plugin stores no provider credentials.

## Commands

* `!vs reina` / `!coach reina`: universal counter-guide, with a button to use your `!main`.
* `!coach kazuya vs reina`: matchup guide with both forward and reverse punish evidence.
* `!coachlang en` / `!coachlang ru`: save language. English is used before a choice.
* `!coachlevel mid` / `!coachlevel high`: save level. Mid is used before a choice.
* Per-request overrides: `!coach kazuya vs reina --lang ru --level high`.
* `!tip vs reina #defense: ...` / `!tip kazuya vs reina: ...`: draft, confirm, admin review.
* `!tips vs reina` / `!mytips`: approved advice and your submissions.
* Owner: `/coach_dossier Reina`, `/coach_status`, `/tips_queue`, `/coach_warm mains`.
* Owner: `/coach_probe` is an optional one-call runtime smoke test, never a benchmark.

## Information supplied with every prompt

All frame facts come from the existing SQLite index: standing/mid/low checks, plus moves,
normal-hit and counter-hit launchers, unsafe moves, lows, strings (natural combo, jail,
interrupt, delay, annotated step/duck conditions), armor/crush/homing/tornado, Heat,
wall properties, throw breaks and punish damage. Category rows are capped at twelve and
ranked using source key moves, approved tip references, combo reward and speed. Each move
linked in source text additionally receives its current facts in an appendix.

For A vs B, both characters are included along with ten interaction tables: punishment
in each direction, string escapes, crouching punishment, plus frames, homing/step evidence,
power crush versus poke candidates, speed comparison, both Heat toolkits and crush versus
hit levels. These are frame candidates; unknown reach, spacing, reaction thresholds and
crush timing remain explicit gaps. A listed interrupt speed is not relabeled as a measured gap.

Wavu counterplay, relevant matchup subsections, strategy and A-side tech are stored in
`data/wavu/t8-guides.json`. Useful pages are retained on partial source failures. The source
text and approved clan tips are untrusted reference blocks, never model instructions. The
prompt includes available/included coverage and source IDs. Sparse coverage requires low
confidence and an evidence-gaps section. Guides and other bot replies carry no per-message site
credits; the Wavu Wiki attribution required by CC BY-SA 4.0 is kept once, in `!help` and the README.
Guides credit only the clan members whose approved tips they used.

Guide retrieval is explicit: the initial snapshot was fetched once during implementation;
future updates use `/fd_sync`. The existing watcher behavior is unchanged. No coach fetch,
generation, warming or benchmark runs on a timer.

## Output and runtime state

JSON must pass schema/length bounds, exact move and side checks, known source IDs, top-five
punish coverage, computed punishment relations and distinct evidence-backed escape checks.
Numeric prose is rejected even if an unrelated matching number exists in the dossier. Character names
(Jack-8) and ordinal words naming a string's hit ("second hit", "второй удар") are allowed. The
renderer inserts current frame facts for `[[id]]`, escapes all text and splits valid Telegram
HTML at the message limit. One corrective retry is allowed; errors return an indexed sheet.
Nonnumeric tactical prose remains model advice and can be reported through feedback.

Private `coach.sqlite` and `tips-state.json` live in the configured state directory outside
the repository. Pending tips, Telegram identities, quotas, language choices and votes never
enter the model dossier or approved-tip file. Only approved display names and advice are
committed to `data/tips/t8-tips.json`; the next `/fd_sync` pushes them. Negative votes and
changed referenced startup/block/hit fields send a tip back for review.

Cache keys include sides, mode, language, level, data/tip hashes, prompt version and model.
Cache hits are unlimited; members get five delivered guides per UTC day (failures and fact-sheet
fallbacks are refunded). Dossiers are memoised by target, data, guide and tip versions, so cache
hits and section buttons do not rebuild them. Exact requests
deduplicate; language/level variants serialize per pair; at most two pairs generate globally.
Live clan membership is checked in DMs and callbacks. Admin warming skips existing cached
guides, processes at most thirty uncached targets per command and has its own lock, so it
never blocks `/fd_sync`.

## Activation

Repository changes do not apply gateway configuration. After owner approval:

```bash
cd /opt/clan-bots
scripts/apply-config.sh --coach-preview
docker compose -f /opt/openclaw/docker-compose.yml restart
```

This opts the plugin into **only** the selected `openai/gpt-6.1-sol` model and starts an
admin preview. When ready, `scripts/apply-config.sh --coach-launch` opens coach and tips
to members of the configured clan groups and their DMs. Allowlist IDs remain private runtime
configuration. The config script backs up the existing config and validates patches first.

The owner must approve the configuration application and shared gateway restart under the
pasted plan's instruction: “Ask the owner before any system-wide change.” Real OAuth runtime
completion has not been claimed verified until activation and an explicit smoke call succeed.

## General knowledge (unverified)

When the written Wavu guides for a character in the request are thin (not "rich"), the model may add
up to two `general_knowledge` items from its own Tekken 8 knowledge: a known gameplan, habit or
mechanic the data does not cover. They obey the same rules (no numbers, only supplied move ids) and
are shown under "⚠️ General knowledge (unverified)". For rich characters the field must be empty.

## Ranked matchup statistics

`/meta_build [days]` (owner, default 7, max 30) scans Wavu Wank's ranked replay API for the current
game version, one request per second (about 123 requests per day of data), maps character ids through
the per-character leaderboards, and commits aggregated counts only to `data/wank/t8-matchups.json`
(no player ids or names). It shares the `/fd_sync` lock and pushes like a sync. CLI: `bin/fd.mjs meta 7`.

Bands use replay rank ids 0–36: all ranks, Tekken King+ (both players ≥ 26) and God of Destruction
(≥ 30). Win rates are shown from 150 games and called reliable from 500; a rating-adjusted value
(actual result minus the Glicko expectation from both players' ratings) is stored alongside. Guides
print the numbers in a header line; the model may only describe them in words (favourable / even /
hard) and must note that ranked results also reflect player skill and popularity.
