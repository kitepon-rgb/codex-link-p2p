# 要件

## 機能要件

### iPhone app

- AppleStore 配布される (最終目標)
- 起動時に device session を持っていれば自動で revalidate
- HostAccess の中から Host を選択できる
- QR スキャン (またはコード入力) で pairing code を redeem できる
- WebRTC peer (offerer) を Mac/Win Host との間で構築できる
- DataChannel 上で turn を送れる
- transcript / timeline / approval / Live Activity を表示できる
- 接続経路 (`direct` / `srflx` / `relay`) をユーザーに見せる
- 復元失敗 / Relay 再起動時に再 pair を案内する

### Mac/Win Host

- `npm install -g @codex-link/host` 一発で導入できる
- `codex-link host init` で pairing code を表示 + Keychain (Mac) / DPAPI (Win) に device token を保存 + `host.json` を生成
- Codex `app-server` の loopback WebSocket を spawn し、stdio / VS Code IPC follower への切り替えを動的に行う
- Relay へ outbound WSS を張る (signaling channel)
- iPhone との WebRTC peer を answerer として張る
- DataChannel 上で `CodexLinkEvent` を送信、command を受信
- replay-on-peer: iPhone からの `session.snapshot.request` に対して現状 projection を返す
- ICE restart で再接続を試みる
- 接続経路を Relay へ報告

### Relay

- Multi-tenant (`User` / `Device` / `Host` / `HostAccess` を分離)
- Device session 認証
- Host bootstrap (bootstrap token 検証 → userId / deviceId / hostId / deviceToken 発行)
- 短命 pairing code 発行 / redeem
- WebRTC signaling envelope (`signal.offer` / `signal.answer` / `signal.ice` / `signal.connectionState`) の中継
- ephemeral TURN credential の発行 (HMAC-SHA1 + `use-auth-secret` 互換)
- HostAccess に基づく ACL 確認
- audit metadata (payload 内容は記録しない)
- rate limit、payload size limit
- Host offline 時の signaling buffer (TTL 30s、pendingSignals)
- HTTP `/api/host-bootstrap`、`/api/device-session`、`/api/device-session/pair`、`/api/health`
- WS `/api/relay` (signaling channel)

## 非機能要件

### 信頼

- **Relay は session payload を観測しない**。物理的に DTLS で暗号化されているため不可能、かつ 実装上も `client.toHost` / `host.event` のような routing を作らない
- **TURN は session payload を観測しない**。同上
- audit metadata は payload 内容を含まない
- データ平面と control 平面 (signaling) を protocol module レベルで分離 (`rendezvous.ts` / `session.ts`)

### 配布

- Mac Host は `npm install -g @codex-link/host` 一発
- Windows Host も同一 npm package で動作 (将来)
- iPhone app は AppleStore 提出可能な署名 / Bundle ID / メタデータを準備 (本リポジトリでは Phase 後)
- Codex CLI は別途必要 (Host 起動時に PATH 検出)

### 互換性

- Node.js >= 20.0.0
- macOS arm64 / x64
- Windows x64 (将来)
- iOS >= 16 (Live Activity 利用のため)

### パフォーマンス

- Codex の `assistant.delta` ストリームを DataChannel reliable/ordered で流す
- Cellular 5G で end-to-end 遅延 < 200ms (signaling 後、direct 経路時)
- TURN 経由でも操作可能、ただし UI に黄色バッジで通知

### 可観測性

- Relay は構造化ログ (JSON Lines)
- audit metadata は queryable
- Host は接続経路を Relay へ報告し、Relay は audit に残す

### 鍵 / 秘匿

- Device token は SHA-256 hash で保存
- Bootstrap token は環境変数経由、ローテーション可
- TURN shared secret は環境変数経由、ローテーション可 (graceful 切替は MVP 後)
- iPhone は Keychain、Mac は Keychain、Win は DPAPI (将来)

### テスト

- `services/relay/test/` で signaling 往復、TURN credential、HostAccess、rate limit
- `apps/mac-host/test/` で peer 確立、Codex event 正規化、re-attach
- `apps/ios/Tests/CodexLinkIOSTests/` で SessionProjection、PeerConnection、SignalingWebSocketClient

## MVP の非目標 (やらない)

- E2E privacy の完全実装 (DTLS-SRTP の範囲を超える追加レイヤー)
- AppleStore 公開対応 (Bundle ID 本番化、Live Activity 互換、配布証明書、プライバシー方針) は別 plan
- Windows Host の MVP 同時リリース (Mac を先行、Windows は同じ protocol で後追い)
- 完全な Codex thread / session 互換
- 中央 Codex 実行 (Codex は Host ローカルのみ)
- placeholder device session 以上の本格 auth (OAuth、SSO 等)
