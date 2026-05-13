# セキュリティモデル

## 信頼前提

- **Relay (kite サーバー)** は信頼境界の外側にある「接続案内人」として扱う。認証された signaling を中継し、ephemeral TURN credential を発行する。**payload は観測しない**。
- **TURN サーバー (coturn)** は対称 NAT 失敗時の中継経路。DTLS-SRTP の E2E 暗号化により payload は復号できない。メタアドレスと帯域は見える。
- **Host (Mac / Win)** は信頼境界の内側。ローカル Codex とローカル副作用を所有する。
- **iPhone app** はユーザーの操作面。Device Token は Keychain に保存。

## 物理的な payload-blind 性

iPhone⇄Host のデータ平面は WebRTC DataChannel 上に乗る。DataChannel は:

- DTLS (Datagram TLS) で end-to-end 暗号化される
- 鍵交換は両端の `RTCPeerConnection` が ICE の上で直接行う (DTLS handshake)
- 鍵は Relay にも TURN にも知らされない
- 結果として **Relay と TURN は payload を復号できない**

これがユーザーの「サーバーは接続案内人」設計の物理的保証。Relay 運用者が悪意を持って payload を read しようとしても、暗号文しか見えない。

## 認証

### Device session

- iPhone は `POST /api/device-session` で device session を作成、Bearer device token を Keychain に保存
- token は SHA-256 hash で Relay 側に保存。生 token を Relay は持たない
- 再起動時は `revalidateDeviceSession` で 401 を検知したら fresh register

### Host bootstrap

- Mac Host installer は `POST /api/host-bootstrap` に bootstrap token を付けて接続
- Relay は `userId` / `deviceId` / `deviceToken` / `hostId` を返す
- token は macOS Keychain (Mac) または DPAPI (Win, 将来) に保存。`host.json` には reference だけ

### Pairing

- Mac Host は signaling channel 上で `host.pairingCode.create` を送信
- Relay は短命 (TTL 60s) かつ 一回限りの code を発行
- iPhone は `POST /api/device-session/pair` で code を redeem
- Relay は `operator` `HostAccess` を付与 (既存 `owner` は降格しない)

## TURN credential

ephemeral、Relay が発行:

- `username = "{unixExpiry}:{userId}"`
- `password = base64(HMAC-SHA1(TURN_SHARED_SECRET, username))`
- TTL は `turnCredentialTtlSec` (既定 300s)
- coturn は `use-auth-secret` mode で `TURN_SHARED_SECRET` を共有し、独立に検証する
- credential を平文で配布された Host / iPhone に保存しない
- rate limit: per-user で発行回数を制限

## ACL (HostAccess)

- すべての routing / listing で現在の user の `HostAccess` を確認
- Relay はグローバル Host 一覧を返さない
- `signal.offer` / `signal.answer` / `signal.ice` の forward は HostAccess を確認してから行う
- `viewer` は send 禁止、`operator` 以上で `signal.offer` を投げられる

## audit

Relay は audit metadata のみ記録する:

- `host.session.initiated` (`userId`、`hostId`、`outcome`)
- `host.session.signal_forwarded` (`fromUserId`、`hostId`、`signalType`、`outcome`) — payload 内容は記録しない
- `turn.credential.issued` (`userId`、`hostId`、`outcome`、`expiresAt`)
- `host.pairing.created` / `host.pairing.redeemed`
- `device.session.created` / `device.session.revoked`
- rate limit hit、payload size violation

audit に SDP 内容 / ICE candidate 内容 / DataChannel payload を **記録しない**。

## rate limit / payload size

`CODEX_LINK_RATE_LIMIT_*` / `CODEX_LINK_MAX_HTTP_BODY_BYTES` / `CODEX_LINK_MAX_WEBSOCKET_PAYLOAD_BYTES` で設定。signaling envelope に対するサイズ上限を設ける (SDP は数 KB、ICE candidate は数百 bytes 程度が普通)。

DataChannel 上の payload には Relay の rate limit はかからない (Relay を通らない)。Host 側で必要なら自前で reject する。

## 既知の脅威と対応

| 脅威 | 対応 |
|---|---|
| Relay 運用者による payload 観測 | DTLS-SRTP E2E で復号不能 |
| TURN 運用者による payload 観測 | DTLS-SRTP E2E で復号不能 (TURN は relayed candidate でしか役割を持たない) |
| Relay 運用者によるメタ観測 | audit に「誰が誰に signal を投げたか」のメタは残る (運用上の責任記録のため、設計上不可避) |
| MitM (signaling 改竄) | signaling は TLS 上、SDP fingerprint で DTLS 鍵検証 |
| pairing code 漏洩 | 短命 (TTL 60s) + 一回限り |
| device token 漏洩 | Keychain 保存、device-granularity で revoke 可 |
| 対称 NAT で hole punch 失敗 | TURN credential で coturn 中継 (E2E は維持) |

## E2E privacy の範囲

DTLS-SRTP は **session payload** に対する E2E。ただし以下は E2E ではない:

- signaling envelope (offer / answer / ICE candidate の **存在**)、Relay は見る
- 接続のメタ (誰が誰に何時繋いだか)、Relay は audit する
- 帯域使用量、TURN は計測する

これらを隠蔽したい場合は Tor 等の追加レイヤーが必要 (MVP 範囲外)。

## 保留事項 (Phase X)

- Device credential のローテーション
- TURN credential のローテーション中の graceful 切替
- pairing code 発行の rate limit
- audit log の長期保管 / 外部出力
- iPhone の Live Activity を AppleStore 配布対応にする時の権限スコープ確認
