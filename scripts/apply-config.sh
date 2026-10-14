#!/usr/bin/env bash
# Apply the clan-bots OpenClaw config. Usage:
#   scripts/apply-config.sh                 # plugin + fd agent only
#   scripts/apply-config.sh -1001234567890  # ...plus route that Telegram group to fd
set -euo pipefail
REPO=/opt/clan-bots
STACK=/opt/openclaw
STATE="$STACK/data/state"
CHAT_ID="${1:-$(cat "$REPO/config/clan-chat-id" 2>/dev/null || true)}"

oc() { docker compose -f "$STACK/docker-compose.yml" exec -T openclaw-gateway openclaw "$@"; }

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
apply "$REPO/config/fd.base.json5"
if [[ -n "$CHAT_ID" ]]; then
  sed "s/__CLAN_CHAT_ID__/$CHAT_ID/g" "$REPO/config/fd.group.json5" | {
    tmp=$(mktemp); cat > "$tmp"; apply "$tmp"; rm -f "$tmp"; }
fi
echo "applied. restart if plugins changed: docker compose -f $STACK/docker-compose.yml restart"
