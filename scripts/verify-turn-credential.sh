#!/bin/sh
# Relay が発行した TURN credential が coturn use-auth-secret 互換であるかを
# 局所で検証するスクリプト.
#
# 使い方:
#   ./scripts/verify-turn-credential.sh "<turn-shared-secret>" "<username>" "<password>"
#
# 例 (Phase 2.3 turn.test.ts と同じ計算):
#   ./scripts/verify-turn-credential.sh test-secret "1700000300:usr_abc" "ZGVtbw=="
#
# 一致したら "OK", しなかったら "MISMATCH" を stdout に出して exit code を切り替える.

set -eu

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <turn-shared-secret> <username> <password>" >&2
    exit 2
fi

SECRET="$1"
USERNAME="$2"
PASSWORD="$3"

# username を HMAC-SHA1(SECRET) し、base64 化.
EXPECTED=$(printf '%s' "$USERNAME" | openssl dgst -sha1 -hmac "$SECRET" -binary | openssl base64 -A)

if [ "$EXPECTED" = "$PASSWORD" ]; then
    echo "OK"
    exit 0
else
    echo "MISMATCH: expected $EXPECTED, got $PASSWORD" >&2
    exit 1
fi
