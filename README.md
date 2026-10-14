# clan-bots

OpenClaw bots for the clan, running on the VPS gateway (`/opt/openclaw`).

## tekken-fd — Tekken 8 frame data in Telegram
`!fd <character> <move>` in the clan group → frame-data card. The model only works out *which*
move was meant; all data comes from [Wavu Wiki](https://wavu.wiki) (CC BY-SA 4.0).

| Path | What |
|---|---|
| `plugins/tekken-fd/` | OpenClaw plugin: tools `tekken_frame_data`, `tekken_pick_move`; owner commands; watcher |
| `data/wavu/t8/*.json` | Per-character snapshots — **source of truth**, one git commit per sync |
| `agents/fd/AGENTS.md` | Instructions for the isolated `fd` agent (copied into its workspace) |
| `config/*.json5` | OpenClaw config fragments; `scripts/apply-config.sh` applies them |

Built index (not in git): `/opt/openclaw/data/state/tekken-fd/t8.sqlite`.

### Commands (everyone)
Replies use Telegram formatting; long sections are collapsed (tap to expand).

| Command | Example | Answer |
|---|---|---|
| `!fd <char> <move>` | `!fd Fahkumram 312` · `!fd kaz hellsweep` · `!fd jin ewgf` | compact card; buttons ◀ ▶ (walk the string), Strings, 🥊 Punish (asker only) |
| several at once | `!fd kaz df1; jin d3` or one per line | one combined reply (max 5) |
| `!punish <char> <frames>` | `!punish kaz -13` | standing / crouching punishers, motion-input timing |
| `!unsafe <char> [frames]` | `!unsafe jin` | moves at −10 (or given) or worse |
| `!list <char> <filter>` | `!list steve lows` · `!list kaz hopkick` | levels, tags, Wavu archetypes |
| `!main <char>` / `!mains` | `!main lars` | your default character (an explicit character still wins); roster |
| `!mu <you> vs <them>` | `!mu lars vs jin` · `!mu jin` | punish sheet for every punishable move |
| `!gaps <char> [string]` | `!gaps jin` · `!gaps jin 1,2,4` | interrupts, jails, CH-only follow-ups |
| `!ss <char>` / `!beat <char> <move> [as <you>]` | `!beat kaz df+2 as lars` | tracking (sparse in Wavu), crush/power crush/punish answers |
| `!whiff <char> <move> [as <you>]` | `!whiff kaz df+2` | recovery window + your options (≈, reach rarely known) |
| `!throws <char>` | `!throws king` | throws with breaks + 🎯 throw-break quiz |
| `!heat <char>` / `!wall <char>` | `!heat kaz` | heat engagers/dash/smash; wall crush/splat/balcony/floor |
| `!quiz [char]` / `!top [char]` | `!quiz jin` | quiz (anyone answers once, all correct score); daily quiz 19:00 MSK in clan groups |
| `!help [command]` | `!help mu` | |

Nicknames: Wavu move aliases, glossary (ewgf, wgf, jab, heat burst…), Wavu archetypes (hopkick, hellsweep,
magic four, orbital, snake edge, power low, shadow cutter, stature kick, clef cannon, slash kick, mid check),
admin-taught move aliases (admin replies to a "did you mean" with the input → `data/move-aliases.json`),
Cyrillic character names (`aliases.ru.json`) and Russian keyboard layout (`!ав кфя ва1` = `!fd kaz df1`).

### Owner commands
`/fd_sync [dry|force]` (with a patch digest preview + 📢 Post-to-group button), `/fd_rebuild`, `/fd_status`,
`/fd_check`, `/fd_stats` (usage counters in `/opt/openclaw/data/state/tekken-fd/stats.json`).

### Coach and clan tips
`!vs Reina` / `!coach Kazuya vs Reina` use **gpt-6.1-sol, high** with indexed facts,
Wavu guides and approved clan advice. `!coachlang en|ru` and `!coachlevel mid|high`
save user choices. `!tip`, `!tips`, `!mytips` provide moderated clan knowledge.
Initially admin preview; launch access is configured clan members, including their DMs.
Owner tools: `/coach_dossier`, `/coach_status`, `/tips_queue`, `/coach_warm mains`.
See [coach.md](docs/coach.md) for prompt contents, privacy, limits and explicit activation.

### Updating data (manual by design)
- Telegram DM to the bot (owner only): `/fd_sync dry` → preview, `/fd_sync` → fetch, commit, rebuild, push to GitHub.
  A live progress message shows each step (frame data, punishers, combos, TekkenDocs tags, commit, push) with
  counts and any characters whose page failed. Nothing is fetched or pushed on a timer, only by command
  (the daily watcher only checks Wavu's edit list and DMs you).
- GitHub push: the deploy key stays on the host. `/fd_sync` writes `.git/push-request`; the
  `tekken-bot-push` systemd service (unprivileged user, sandboxed) copies `main` into a private mirror and pushes it
  without force, then writes `.push/status.json` for the bot. Setup: `sudo scripts/push/install.sh <deploy key>`.
  `/fd_status`, `/fd_check` (run the Wavu change watcher now), `/fd_rebuild`.
- The watcher checks Wavu once a day and DMs the owner which movelists were edited. It never syncs by itself.
- Server: `docker compose -f /opt/openclaw/docker-compose.yml exec openclaw-gateway node /opt/clan-bots/plugins/tekken-fd/bin/fd.mjs sync --dry`

### Rolling back a bad sync
```bash
cd /opt/clan-bots && git log --oneline -- data/   # find the sync commit
git revert <commit>                               # then in Telegram: /fd_rebuild
```

### Tests
```bash
docker run --rm --network none -v /opt/clan-bots:/opt/clan-bots:ro -w /opt/clan-bots/plugins/tekken-fd \
  --entrypoint node ghcr.io/openclaw/openclaw:2026.10.3 --test 'test/*.test.js'
```

### Deploying config changes
`scripts/apply-config.sh [<clan chat id>]` — backs up `openclaw.json`, dry-runs, then patches.
Your Telegram user id and the clan group id go in `config/local.env` (git-ignored; copy `config/local.env.example`).
Restart the gateway after plugin code changes: `docker compose -f /opt/openclaw/docker-compose.yml restart`.

## Data sources (fetched automatically by `/fd_sync`)
| File | Source | Used for |
|---|---|---|
| `data/wavu/t8/*.json` | [Wavu Wiki](https://wavu.wiki) Cargo table `Move` (api.php) | frame data, notes, aliases, tags, archetypes |
| `data/wavu/t8-punishers.json` | Wavu "`<Character> punishers`" pages | community-picked punishers (⭐), combo/mini damage, hard flags |
| `data/wavu/t8-combos.json` | Wavu "`<Character> combos`" pages | combo damage per launcher (route without Heat/Rage, Heat route separately) |
| `data/tekkendocs/t8-tags.json` | [TekkenDocs](https://tekkendocs.com) API | second source for homing / step (SSL/SSR/SWL/SWR) / duckable / tornado tags |
| `data/wavu/t8-stances.json` | Wavu character pages (stance lists) | readable move names: "SSH.3" → "Senshin 3", stance entry inputs on cards |
| `data/wavu/t8-guides.json` | Wavu counterplay / strategy / tech pages | grounded coach prose and matchup-specific community knowledge |
| `data/tips/t8-tips.json` | Admin-approved clan submissions | credited clan advice (display names only) |

Every sync keeps a source's previous file if a fetch comes back (nearly) empty, writes stable sorted JSON,
commits the change, rebuilds the index and lists which sources changed. The daily watcher reports edits to
Wavu movelist, combos and punishers pages.

**Licence of the data:** Wavu Wiki content is [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/);
the snapshots under `data/wavu/` are derived from it and are shared under the same licence, credit: Wavu Wiki
contributors. TekkenDocs data is attributed to [tekkendocs.com](https://tekkendocs.com) (itself largely derived from Wavu).
