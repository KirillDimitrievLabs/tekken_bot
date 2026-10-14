#!/usr/bin/env bash
# One-time host setup for the GitHub push service (run as root). Re-run after editing push-github.sh.
#   scripts/push/install.sh /path/to/deploy_key
# Uninstall: systemctl disable --now tekken-bot-push.path; rm /etc/systemd/system/tekken-bot-push.*
#            /usr/local/libexec/tekken-bot-push; rm -r /var/lib/tekken-bot-push /opt/clan-bots/.push; userdel tekkenpush
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
KEY=${1:-/root/.ssh/tekken_bot_deploy}
HOME_DIR=/var/lib/tekken-bot-push

id tekkenpush >/dev/null 2>&1 || useradd --system --home-dir "$HOME_DIR" --no-create-home --shell /usr/sbin/nologin tekkenpush
install -d -o tekkenpush -g tekkenpush -m 700 "$HOME_DIR"
install -o tekkenpush -g tekkenpush -m 600 "$KEY" "$HOME_DIR/deploy_key"
ssh-keygen -F github.com -f /root/.ssh/known_hosts | grep -v '^#' > "$HOME_DIR/known_hosts"
chown tekkenpush:tekkenpush "$HOME_DIR/known_hosts"; chmod 644 "$HOME_DIR/known_hosts"
# status dir: written by the service, read by the bot (uid 1000 in the container)
install -d -o tekkenpush -g tekkenpush -m 755 /opt/clan-bots/.push
install -d -m 755 /usr/local/libexec
install -o root -g root -m 755 "$HERE/push-github.sh" /usr/local/libexec/tekken-bot-push
install -o root -g root -m 644 "$HERE/tekken-bot-push.service" "$HERE/tekken-bot-push.path" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tekken-bot-push.path
echo "installed; test with: touch /opt/clan-bots/.git/push-request && sleep 5 && cat /opt/clan-bots/.push/status.json"
