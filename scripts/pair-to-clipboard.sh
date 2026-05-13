#!/usr/bin/env bash
# pair-to-clipboard.sh — 実機 iPhone セットアップ補助.
#
# 流れ:
#   1. Mac Host を本番 Relay 向けに起動済み + ペアリングコード発行可能な状態
#   2. このスクリプトが:
#      a. iPhone 用 device session を発行 (POST /api/device-session/register)
#      b. Mac Host から pairing code を発行 (codex-link-host pair)
#      c. iPhone を host にひも付け (POST /api/device-session/pair)
#      d. iPhone onboarding 用 JSON を生成して pbcopy に流す
#   3. iPhone (Universal Clipboard で同期済み) で onboarding の
#      "Paste from Clipboard" ボタンを押すと 5 フィールドが一括埋め → Connect
#
# 前提:
#   - `~/.codex-link-p2p/host.json` が存在し対応する session token が
#     Keychain に入っている (`codex-link-host init` 済み).
#   - Universal Clipboard (Continuity) が有効. = Mac と iPhone が同じ Apple ID で
#     サインインし、両方とも Wi-Fi+Bluetooth ON で互いに見えていること.
#
# 使い方:
#   scripts/pair-to-clipboard.sh
#   (オプション: --relay URL  --bootstrap-token TOKEN)

set -euo pipefail

RELAY_URL=""
BOOTSTRAP_TOKEN=""
DISPLAY_NAME="iPhone (manual pair)"

while [ $# -gt 0 ]; do
  case "$1" in
    --relay) RELAY_URL="$2"; shift 2 ;;
    --bootstrap-token) BOOTSTRAP_TOKEN="$2"; shift 2 ;;
    --display-name) DISPLAY_NAME="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

CONFIG_PATH="${CODEX_LINK_HOME:-$HOME/.codex-link-p2p}/host.json"
if [ ! -f "$CONFIG_PATH" ]; then
  echo "[error] $CONFIG_PATH not found. Run \`codex-link-host init\` first." >&2
  exit 1
fi

if [ -z "$RELAY_URL" ]; then
  RELAY_URL=$(jq -r .relayUrl "$CONFIG_PATH")
fi
HOST_ID=$(jq -r .hostId "$CONFIG_PATH")

# bootstrap_token: 引数 → 環境変数 → サーバから引っ張る (LAN内 .env から) の優先順.
if [ -z "$BOOTSTRAP_TOKEN" ]; then
  BOOTSTRAP_TOKEN="${CODEX_LINK_HOST_BOOTSTRAP_TOKEN:-}"
fi
if [ -z "$BOOTSTRAP_TOKEN" ]; then
  echo "[info] --bootstrap-token も env も無いので server から取得を試みます (ssh kite@192.168.1.2)" >&2
  BOOTSTRAP_TOKEN=$(ssh kite@192.168.1.2 'grep ^CODEX_LINK_HOST_BOOTSTRAP_TOKEN ~/codex-link-p2p/.env | cut -d= -f2' 2>/dev/null || true)
fi
if [ -z "$BOOTSTRAP_TOKEN" ]; then
  echo "[error] bootstrap token が手に入りません. --bootstrap-token <T> で渡してください." >&2
  exit 1
fi

echo "[1/4] register iPhone device session ($RELAY_URL)"
REG=$(curl -fsS -X POST "$RELAY_URL/api/device-session/register" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t "$BOOTSTRAP_TOKEN" --arg n "$DISPLAY_NAME" \
        '{bootstrapToken:$t, displayName:$n, platform:"ios"}')")
IPHONE_USER=$(echo "$REG" | jq -r .userId)
IPHONE_DEVICE=$(echo "$REG" | jq -r .deviceId)
IPHONE_TOKEN=$(echo "$REG" | jq -r .sessionToken)
echo "    userId=$IPHONE_USER  deviceId=$IPHONE_DEVICE"

echo "[2/4] issue pairing code from Mac Host"
CODE=$(codex-link-host pair --relay "$RELAY_URL" 2>&1 | tail -1)
if [ -z "$CODE" ] || [ "${#CODE}" -lt 4 ]; then
  echo "[error] pairing code 取得失敗: $CODE" >&2
  exit 1
fi
echo "    code=$CODE"

echo "[3/4] redeem on behalf of iPhone (grant HostAccess)"
ACCESS=$(curl -fsS -X POST "$RELAY_URL/api/device-session/pair" \
  -H "Authorization: Bearer $IPHONE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg c "$CODE" '{pairingCode:$c, role:"operator"}')")
echo "    role=$(echo "$ACCESS" | jq -r .hostAccess.role)"

echo "[4/4] copy onboarding JSON to clipboard"
PAYLOAD=$(jq -n \
  --arg u "$RELAY_URL" \
  --arg t "$IPHONE_TOKEN" \
  --arg user "$IPHONE_USER" \
  --arg dev "$IPHONE_DEVICE" \
  --arg host "$HOST_ID" \
  '{relayUrl:$u, sessionToken:$t, userId:$user, deviceId:$dev, hostId:$host}')
echo "$PAYLOAD" | pbcopy
echo ""
echo "クリップボードに JSON を入れました. iPhone 側で:"
echo "  1. Codex Link app を起動 (onboarding 画面が出る)"
echo "  2. 'Paste from Clipboard (JSON)' ボタンをタップ"
echo "  3. 'Connect' をタップ"
echo ""
echo "Universal Clipboard が効いていれば iPhone 側でそのまま paste できます."
echo "効かない場合 (= Apple ID が違う / Bluetooth/Wi-Fi 状態) は AirDrop 経由などで"
echo "下記 JSON を iPhone に転送してから paste してください:"
echo ""
echo "$PAYLOAD"
