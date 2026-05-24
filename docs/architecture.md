# アーキテクチャ

## 概要

```text
Codex Link iPhone app
  <---(WSS: signaling + auth)---> Codex Link Relay <---(WSS: signaling + auth)---> Codex Link Mac/Win Host
  <----(WebRTC DataChannel, DTLS-SRTP, E2E)----> Codex Link Mac/Win Host           --> local Codex CLI / app-server
```

Relay は **認証付きの接続案内人** (rendezvous)。具体的には: 認証、Host registry、online state、HostAccess の管理、**WebRTC signaling envelope の中継**、**ephemeral TURN credential の発行**。

Codex Link Host (Mac / 将来 Win) はローカル Codex を所有する。inbound port を持たない (Relay へ outbound WSS、iPhone へは ICE 越しの DataChannel)。

iPhone app は raw Codex `app-server` JSON-RPC を直接話さない。`packages/protocol/session` の Codex Link protocol だけを話す。

## Relay の責務

やること:
- ユーザー認証 / device session
- Device 登録 / 取り消し
- Host 登録 / bootstrap
- Host online / offline 状態
- HostAccess (owner / operator / viewer) による Host 一覧 ACL
- iPhone⇄Host 間の **WebRTC signaling envelope の中継** (offer / answer / ICE candidate / connection state)
- **ephemeral TURN credential の発行** (coturn `use-auth-secret` 互換 HMAC-SHA1)
- 短命 pairing code の発行 / redeem
- audit metadata (signaling meta のみ、payload 内容は記録しない)
- rate limit、payload size limit

絶対にやらないこと:
- データ payload (`CodexLinkEvent` / command / approval / snapshot) のルーティング
- event cache
- Codex を実行する
- ローカル project folder を読む
- SSH 鍵を持つ
- `~/.codex` を持つ
- Codex thread / session の正本になる

## Host の責務

- 可能な限り `npm install` 一発で設定できるようにする
- Device / Host として認証する
- Relay へ outbound WSS (signaling channel) を開く
- ローカル Codex を spawn または attach
- iPhone との WebRTC peer を維持 (Host は answerer 固定)
- DataChannel で Codex Link event を iPhone に送る
- DataChannel で command / approval を受ける
- replay-on-peer: iPhone からの `session.snapshot.request` に対して現状 projection を 1 メッセージで返す
- 承認、ローカル副作用、ローカル file 操作はすべて Host 内で完結

## iPhone app の責務

- User / Device として認証する
- 起動時に前回の conversation / thread を復元する
- HostAccess の中から Host を選ぶ
- WebRTC peer (iPhone が offerer) を構築する
- DataChannel 経由で turn を送る
- 進行状況、transcript、timeline を表示する
- 承認カードを表示する
- Live Activity を更新する
- 接続経路 (`direct` / `srflx` / `relay`) を可視化する

## ルーティングモデル (signaling)

```text
1. iPhone が Relay へ WSS 接続 (Bearer: device token)
2. Mac Host が Relay へ WSS 接続 (Bearer: device token)
3. iPhone が `turn.credential.request` → Relay が ephemeral TURN credential を発行
4. iPhone が ICE 構成 (STUN + TURN) を peer に注入し、`RTCPeerConnection.offer()` を作成
5. iPhone が `signal.offer { hostId, sdp }` を Relay へ
6. Relay が HostAccess を確認、Mac Host の WSS へ `signal.offerForwarded` を forward (Host offline 時は pendingSignals に TTL 30s で buffer)
7. Mac Host も `turn.credential.request` を発行 (peer 毎)
8. Mac Host が answer を生成、`signal.answer` を Relay 経由で iPhone へ
9. 両端から ICE candidate を `signal.ice` で逐次交換
10. DataChannel `codex-link-session` が open → 以降、`CodexLinkEvent` / command は **すべて DataChannel** で iPhone⇄Mac Host 直接
```

Relay は signaling envelope を base64 のまま forward する。SDP / ICE 内容を Relay は読まない。

## プロトコル境界

```text
Codex app-server protocol           ── Host 内部のみで使う
Codex Link rendezvous protocol      ── iPhone / Relay / Host が共有 (signaling + auth + TURN credential)
Codex Link session protocol         ── iPhone / Host が DataChannel 上で直接話す (Relay は知らない)
```

`packages/protocol/src/rendezvous.ts` と `packages/protocol/src/session.ts` を物理的に分離する。`services/relay` は session を import 禁止。

## Codex app-server 連携

Host は Codex app-server client として振る舞う。

優先する経路 (動的に選択):

1. **VS Code Codex 拡張の IPC socket** (`$TMPDIR/codex-ipc/ipc-$UID.sock`) — VS Code 起動中のみ
2. **loopback WebSocket** (`codex app-server --listen ws://127.0.0.1:0`) — 既定経路。Mac Host が起動時に spawn し、port を `$TMPDIR/codex-link-app-server.json` に書き出す
3. **stdio transport** (= 自前で `codex` を spawn) — fallback

優先経路 1, 2 で受けた Codex event を Host が `CodexLinkEvent` に正規化し、DataChannel 経由で iPhone に流す。

## Codex Link event model

Relay は **知らない**。Host が `CodexLinkEvent` に正規化し、DataChannel 上だけで流す。

初期 event 種別:

- `host.online` / `host.offline` (※ これは Relay が signaling 上で別途扱う、DataChannel ではない)
- `host.capabilities.updated`
- `project.list.updated`
- `thread.started`
- `turn.status.changed`
- `assistant.delta`
- `assistant.final`
- `transcript.item.recorded`
- `timeline.item.started`
- `timeline.item.completed`
- `approval.requested`
- `approval.resolved`
- `rate_limit.updated`
- `error.reported`

Transcript と timeline は別 projection。

## 接続経路の可視化

iPhone UI で接続中の WebRTC 経路を表示する:

- `direct`: 両端が host candidate で繋がった (同一 LAN 等)
- `stunReflexive`: STUN で得た srflx candidate で hole-punch 成功
- `turnRelayed`: 対称 NAT で hole punch 失敗 → coturn 中継 (TURN は DTLS payload を復号できない、メタアドレスだけ知る)
- `connecting`: ICE 中
- `failed`: 接続不能

`RTCPeerConnection.statistics(...)` の selected candidate pair から `candidateType` を 5s 周期で取得して反映する。

## 公開デプロイ構成

MVP では Relay と coturn を kite サーバー (`kitepon.dev`) に Docker Compose でデプロイする。

- **DNS**: 動的 DNS で `codex-link-p2p.kitepon.dev` を自宅 router の WAN IP に向ける (HTTPS + TURN を 1 ホスト名に同居)
- **TLS / リバースプロキシ**: 既存の `caddy:2` コンテナの `Caddyfile` に sub-domain ブロックを追加し、`reverse_proxy <LAN IP>:3000 { flush_interval -1 }` で Relay へ forward。WebSocket upgrade は Caddy が自動で扱う
- **Relay コンテナ**: `compose.yaml` で build、`-p 127.0.0.1:3000:3000` で LAN bind、Caddy 経由でのみ外部公開
- **coturn コンテナ**: `network_mode: host` で host network 上に listen (3478/udp+tcp、49152-65535/udp range)。`turns` 用 TLS は Caddy で TCP/443 (SNI) を `5349` に振り分けるか、coturn 内蔵で cert を読む
- **TURN credential**: Relay が HMAC-SHA1(`TURN_SHARED_SECRET`) で ephemeral に発行 (TTL 300s)。配布された Host や iPhone は credential 直書きしない

## Relay 状態の前提

現 MVP の Relay は in-memory のみ (optional state snapshot は MVP 後)。
コンテナ再起動 = 全 device session / HostAccess / pairing code 喪失。
iPhone / Mac Host 側は起動時に session token を再 validate し、401 を検知したら
fresh register に倒す自動リカバリを持つが、HostAccess は復旧不能なので
**Relay 再起動後はユーザーに QR 再 pair を要求**する。

Phase X (MVP 後) で state 永続化と TURN credential / device token のローテーション
を入れる。

## 実装状態 (MVP)

Phase 1-7 の実装で:
- protocol (TS) と CodexLinkIOS (Swift) の wire 互換は WireCompatibilityTests
  で検証済み.
- Relay の HTTP/WS endpoint は services/relay/test の 105 本でカバー
  (payload-blind 不変条件含む).
- Mac Host は signaling-client / peer (node-datachannel answerer) /
  session (Codex event normalize → DataChannel broadcast) を実装し、
  in-process E2E (apps/mac-host/test/e2e-flow.test.ts) が DataChannel 双方向
  疎通まで通っている.
- iOS は SignalingWebSocketClient (URLSession WS) + PeerConnection
  (WebRTC.framework, offerer 固定) + SessionProjection + AppLifecycle まで
  完成。connection path (direct/srflx/relay) も candidate-pair stats から
  算出して UI バッジに反映.
- coturn は use-auth-secret 互換で Relay の HMAC 発行と同期、scripts/
  verify-turn-credential.sh で対称性検証.
- npm 一発配布 (`@codex-link/host`) は Phase 9 で詰める.

## 実機検証で判明した既知の応急処置 (2026-05-14)

実機 iPhone (iOS 26.5、Wi-Fi/5G) と本番 Relay (`codex-link-p2p.kitepon.dev`) で
E2E 通信を確認した時点で、暫定で凌いだ箇所を [BOOTSTRAP.md の TODO セクション](../BOOTSTRAP.md#todo--既知の応急処置-phase-9-完走後に判明)
に集約している. 要点:

- iOS の正規 QR pairing UI が未実装. 当面は手 paste + ファイル push.
- Mac Host PeerManager が ICE-failed peer を自動 cleanup できず、stale peer が
  新規接続を阻害する. 暫定対処は Mac Host プロセスの再起動.
- iOS 各層に NSLog + file 出力の診断ログを埋め込んでいる. 本番には不要.

これらは Phase 1-9 の主要設計 (Relay payload-blind / iPhone⇄Mac 直 DataChannel /
DTLS-SRTP E2E) は変えずに、UX と運用の磨きに該当する.
