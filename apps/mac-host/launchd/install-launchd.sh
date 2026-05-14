#!/usr/bin/env bash
# Codex Link p2p Mac Host を launchd agent として install する.
#
# 使い方:
#   bash apps/mac-host/launchd/install-launchd.sh [INSTALL_PATH]
#
# INSTALL_PATH を省略すると、git repo の root から相対で
# apps/mac-host/dist/cli.js を見にいく.
#
# 旧 broker 版の plist (dev.codex-link.mac-host) が居る場合は事前に
# unload + 削除すること:
#   launchctl unload ~/Library/LaunchAgents/dev.codex-link.mac-host.plist
#   rm ~/Library/LaunchAgents/dev.codex-link.mac-host.plist
#
# 確認:
#   launchctl list | grep dev.codex-link
#   tail -f ~/Library/Logs/codex-link-p2p-mac-host.log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_PATH="${1:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
TEMPLATE="$SCRIPT_DIR/dev.codex-link-p2p.mac-host.plist"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET="$TARGET_DIR/dev.codex-link-p2p.mac-host.plist"

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: template not found: $TEMPLATE" >&2
  exit 1
fi

if [ ! -f "$INSTALL_PATH/apps/mac-host/dist/cli.js" ]; then
  echo "ERROR: cli.js not found at $INSTALL_PATH/apps/mac-host/dist/cli.js" >&2
  echo "  先に \`pnpm --filter @codex-link/host build\` を実行してください" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
mkdir -p "$HOME/Library/Logs"

# 既に load 済なら unload してから書き換える.
if launchctl list | awk '{print $3}' | grep -q '^dev\.codex-link-p2p\.mac-host$'; then
  echo "Unloading existing agent..."
  launchctl unload "$TARGET" 2>/dev/null || true
fi

# template の placeholder を置換して書き出し.
sed \
  -e "s|__INSTALL_PATH__|$INSTALL_PATH|g" \
  -e "s|__USER_HOME__|$HOME|g" \
  "$TEMPLATE" > "$TARGET"

# Validate plist.
plutil -lint "$TARGET" >/dev/null

# Load.
launchctl load "$TARGET"

echo "Installed: $TARGET"
echo "Status:"
launchctl list | grep -E 'dev\.codex-link' || true
echo
echo "Logs:"
echo "  tail -f $HOME/Library/Logs/codex-link-p2p-mac-host.log"
echo "  tail -f $HOME/Library/Logs/codex-link-p2p-mac-host.err"
echo
echo "Uninstall:"
echo "  launchctl unload $TARGET && rm $TARGET"
