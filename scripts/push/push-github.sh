#!/usr/bin/env bash
# Push the bot repo's main branch to GitHub. Run by tekken-bot-push.service when the bot writes
# .git/push-request (end of /fd_sync). Installed root-owned to /usr/local/libexec/tekken-bot-push
# and run as the unprivileged "tekkenpush" user.
#
# The repo is writable from the OpenClaw container, so it is treated as untrusted: git only *fetches*
# from it into a private mirror (no hooks or config of the bot repo run here), and the mirror pushes
# with its own key and settings. Never forces: a diverged GitHub branch is reported, not overwritten.
set -uo pipefail
SRC=/opt/clan-bots
HOME_DIR=/var/lib/tekken-bot-push
MIRROR="$HOME_DIR/mirror.git"
STATUS_DIR="$SRC/.push"
URL=git@github.com:KirillDimitrievLabs/tekken_bot.git
export GIT_SSH_COMMAND="ssh -i $HOME_DIR/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$HOME_DIR/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20"
export GIT_TERMINAL_PROMPT=0

write_status() { # ok head message
  python3 -I - "$STATUS_DIR/status.json" "$@" <<'PY'
import json, os, sys, datetime
path, ok, head, msg = sys.argv[1:5]
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump({"ok": ok == "true", "head": head, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"), "message": msg[-300:]}, f)
    f.write("\n")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
}

[[ -d "$MIRROR" ]] || git init -q --bare "$MIRROR"
if ! out=$(timeout 120 git -C "$MIRROR" -c safe.directory="$SRC" -c safe.directory="$SRC/.git" fetch -q --no-tags "$SRC" "+refs/heads/main:refs/heads/main" 2>&1); then
  write_status false "" "reading the bot repo failed: ${out##*$'\n'}"; exit 1
fi
head=$(git -C "$MIRROR" rev-parse refs/heads/main)
if out=$(timeout 120 git -C "$MIRROR" push --porcelain "$URL" refs/heads/main:refs/heads/main 2>&1); then
  if grep -q '^=' <<<"$out"; then msg="already up to date"; else msg="pushed"; fi
  write_status true "$head" "$msg"
else
  if grep -q 'rejected' <<<"$out"; then msg="rejected: GitHub has commits the bot doesn't (merge them on the server first)"
  else msg="push failed: $(grep -v '^\s*$' <<<"$out" | tail -1)"; fi
  write_status false "$head" "$msg"; exit 1
fi
