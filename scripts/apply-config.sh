#!/usr/bin/env bash
# Apply the clan-bots OpenClaw config. Personal ids live in config/local.env (git-ignored,
# see config/local.env.example). Usage:
#   scripts/apply-config.sh                 # plugin + fd agent (+ CLAN_CHAT_ID group if set)
#   scripts/apply-config.sh -1001234567890  # ...route this Telegram group to fd instead
set -euo pipefail
REPO=/opt/clan-bots
STACK=/opt/openclaw
STATE="$STACK/data/state"
OWNER_ID="" CLAN_CHAT_ID=""
# shellcheck source=/dev/null
[[ -f "$REPO/config/local.env" ]] && source "$REPO/config/local.env"
COACH_MODE=""
case "${1:-}" in
  --coach-preview|--coach-launch) COACH_MODE="${1#--coach-}"; shift ;;
esac
CHAT_ID="${1:-$CLAN_CHAT_ID}"

oc() { docker compose -f "$STACK/docker-compose.yml" exec -T openclaw-gateway openclaw "$@"; }

if [[ ! "$OWNER_ID" =~ ^[0-9]+$ ]]; then
  echo "set OWNER_ID (your Telegram user id) in $REPO/config/local.env" >&2; exit 2
fi
if [[ -n "$CHAT_ID" && ! "$CHAT_ID" =~ ^-[0-9]+$ ]]; then
  echo "chat id must look like -1001234567890" >&2; exit 2
fi

cp -a "$STATE/openclaw.json" "$STATE/openclaw.json.bak-$(date +%Y%m%d-%H%M%S)"

# fd agent workspace instructions (copied, the agent has no access to the repo)
install -d -o 1000 -g 1000 "$STATE/workspace-fd"
install -m 644 -o 1000 -g 1000 "$REPO/agents/fd/AGENTS.md" "$STATE/workspace-fd/AGENTS.md"

apply() {
  oc config patch --stdin --dry-run < "$1" >/dev/null
  oc config patch --stdin < "$1"
}
sed "s/__OWNER_ID__/$OWNER_ID/g" "$REPO/config/fd.base.json5" | {
  tmp=$(mktemp); cat > "$tmp"; apply "$tmp"; rm -f "$tmp"; }
if [[ -n "$CHAT_ID" ]]; then
  sed "s/__CLAN_CHAT_ID__/$CHAT_ID/g" "$REPO/config/fd.group.json5" | {
    tmp=$(mktemp); cat > "$tmp"; apply "$tmp"; rm -f "$tmp"; }
fi
if [[ -n "$COACH_MODE" ]]; then
  apply "$REPO/config/coach.preview.json5"
  if [[ "$COACH_MODE" == launch ]]; then apply "$REPO/config/coach.launch.json5"; fi
fi
echo "applied. restart if plugins changed: docker compose -f $STACK/docker-compose.yml restart"
