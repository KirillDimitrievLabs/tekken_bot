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

### Updating data (manual by design)
- Telegram DM to the bot (owner only): `/fd_sync dry` → preview, `/fd_sync` → fetch, commit, rebuild.
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
Restart the gateway after plugin code changes: `docker compose -f /opt/openclaw/docker-compose.yml restart`.
