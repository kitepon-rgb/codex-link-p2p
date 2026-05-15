# BOOTSTRAP.md

このプロジェクトに入ってきた **新しい Claude セッション**向けの引き継ぎ書。最初にこれと [CLAUDE.md](CLAUDE.md) を必ず読む。

> **⚠ ARCHIVED (2026-05-15)**
> プロジェクト終了。OpenAI 公式 Codex mobile (ChatGPT iOS app) に追従不能と
> 判断 (2026-05-14 発表)。詳細は [POSTMORTEM.md](POSTMORTEM.md) を読むこと。
> 以下の Phase 1〜9 の歴史記録は当時の到達点として保全する。新セッションが
> このリポジトリで実装を再開する場合は、POSTMORTEM の「7. 公式版を使う上で
> の切替手順」も読んだ上で着手判断を user に確認すること。

> **状態 (2026-05-14 時点 = Archive 直前): Phase 1〜9 完走済**. 後続の Phase 10〜14 (MVP 完成までの計画) は
> [docs/roadmap.md](docs/roadmap.md) に集約。本書は Phase 1〜9 の歴史的記録と、Phase 9
> 完走時に判明した応急処置 (TODO セクション) を残す。

## このプロジェクトは何か

`codex-link-p2p`: iPhone から自宅 Mac (将来 Windows) 上の Codex CLI / `app-server` を操作するためのアプリ。

3 つの面で構成する:
- `apps/ios` (ネイティブ iPhone app、将来 AppleStore 配布)
- `apps/mac-host` (macOS Host、`npm install -g @codex-link/host` 一発配布)
- `services/relay` (kite サーバー `kitepon.dynv6.net` で動くマルチテナント **認証 + signaling + TURN credential 発行**ハブ)

共有コード:
- `packages/protocol` (wire 型。`rendezvous` と `session` を物理的に分離)
- `packages/codex-client` (Codex `app-server` client)

データ平面は **WebRTC DataChannel で iPhone⇄Mac Host 直接通信**。Relay は接続案内人として認証と signaling envelope の中継、TURN credential の発行だけを行う。DTLS-SRTP の E2E 暗号化により Relay も TURN も payload を **復号できない**。

## 設計原則 (再確認、絶対)

[CLAUDE.md](CLAUDE.md) の「守るべきアーキテクチャ鉄則」と「してはいけないこと」を読むこと。要点:

- Relay は payload を観測しない
- `client.toHost` / `host.event` を作らない
- データ平面は WebRTC DataChannel のみ、Relay 経由禁止
- STUN: Google public / TURN: kite サーバーに同居 coturn
- protocol は rendezvous と session で物理分離

## 隣のリポジトリ `../codex-link` の扱い

`/Users/kite/Developer/codex-link/` は broker 型で動く参照実装。**読み出し参照のみ**。

再利用候補ファイル (broker 依存を除去してコピー):
- `apps/mac-host/src/codex-events.ts` (Codex app-server event → CodexLinkEvent 正規化)
- `apps/mac-host/src/codex.ts` (Codex app-server spawn / IPC follower)
- `apps/mac-host/src/{config,capabilities,session}.ts` (broker 経路の `relay-client` 依存を除去)
- `apps/ios/Sources/CodexLinkIOS/SessionProjection.swift` (transcript / timeline / approval projection)
- `apps/ios/Sources/CodexLinkIOS/LiveActivity.swift` (Live Activity state)
- `apps/ios/Sources/CodexLinkIOS/CodexLinkRootView.swift` / `CodexLinkPreviewCanvas.swift` (UI 全般)
- `apps/ios/Sources/CodexLinkIOS/AppLifecycle.swift` (起動 / 復元 / 再接続のオーケストレーション。Relay 接続部分は SignalingWebSocketClient に置き換え)
- `services/relay/src/{relay,state,config}.ts` の **broker に依存していない部分** (User / Device / Host registry、HostAccess、pairing code、audit、rate limit)
- `services/relay/src/persistence.ts` (event cache schema は不要なので除外、それ以外は流用可)
- `scripts/codex-app-server-smoke.mjs` 系 (動作確認用)
- `docker-compose.yml` (構造を参考に、`coturn` を追加)

**コピーしてはいけないもの**:
- `services/relay/src/websocket.ts` の `client.toHost` / `host.event` / `host.subscription.ready` 関連 (= broker 本体)
- `services/relay/src/relay.ts` の `appendHostEvent` / `readHostEventReplay` / `routeToHost` / event cache 関連
- `apps/mac-host/src/relay-client.ts` の `sendHostEvent` 系
- `apps/ios/Sources/CodexLinkIOS/RelayWebSocketClient.swift` / `RelayMessages.swift` の `hostEvent` / `hostMessage` / `hostSubscriptionReady`

## ここまでで整っているもの

本 plan セッションで整えた:
- ディレクトリ構造 (`packages/`、`services/`、`apps/`、`docs/`、`scripts/`)
- `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`
- `.gitignore`
- `CLAUDE.md` (鉄則)
- `BOOTSTRAP.md` (本ファイル)
- `docs/{architecture,security-model,requirements,mvp-plan}.md` (P2P 前提の初期版)
- `compose.yaml` (relay + coturn skeleton)
- 各 workspace package の `package.json` / `tsconfig.json` / `src/index.ts` スケルトン
- `apps/ios/Package.swift` skeleton

新セッションが行う最初の確認:
```bash
cd /Users/kite/Developer/codex-link-p2p
pnpm install            # node_modules を入れる
pnpm typecheck          # 空 workspace でエラーゼロのはず
git status              # 初期コミット候補
```

## 実装計画: Phase 1 - 9

順番に進めることを想定。各 Phase 完了時にテストを通してから次へ。

### Phase 1: Protocol 分割と signaling 型定義

`packages/protocol/src/` に:
- `rendezvous.ts`: `UserId` / `DeviceId` / `HostId` (branded)、`User` / `Device` / `Host` / `HostAccess` / `HostPairingCode`、新規 `RtcSignalOffer` / `RtcSignalAnswer` / `RtcIceCandidate` / `RtcConnectionState` / `TurnCredential` (ephemeral, `expiresAt` 付き)
- `session.ts`: `CodexLinkEvent` 全種 + `CodexLinkUIAction` + `ApprovalRequest` (DataChannel 専用)
- `index.ts`: 再 export はしない (rendezvous と session を意図的に呼び分けさせる)

`packages/protocol/package.json` exports map に `./rendezvous` と `./session` を設定。

検証:
- `services/relay` から `@codex-link/protocol/session` を import するとビルドエラーになるよう ESLint rule (`no-restricted-imports`) または tsconfig path で禁止
- 単体テスト: 型のシリアライズ / デシリアライズ (vitest)

### Phase 2: Relay 実装 (signaling-only から)

`services/relay/src/`:
- `server.ts`: HTTP listen
- `config.ts`: `turnSharedSecret`、`turnRealm`、`turnUrls`、`turnCredentialTtlSec`、`rateLimit*`、`maxHttpBodyBytes`、`maxWebsocketPayloadBytes`、`relayUrl`
- `state.ts`: `users`、`devices`、`hosts`、`hostAccess`、`pairingCodes`、`auditEvents`、`pendingSignals: Map<HostId, SignalEnvelope[]>` (TTL 30s)、`turnCredentialIssuance` (rate limit)。**`eventCache` 系は一切作らない**
- `persistence.ts`: optional state snapshot (broker の event cache schema は不要)
- `relay.ts`: `createUser`、`createDevice`、`bootstrapHost`、`createPairingCode`、`redeemPairingCode`、`assertHostSessionInitiator`、`forwardSignal(fromUserId, hostId, signal)`、`issueTurnCredential(userId, hostId)`、`recordAudit`
- `websocket.ts`: HTTP upgrade、`handleSignalingMessage` だけ。**`client.toHost` / `host.event` / `host.subscription.ready` を作らない**
  - Client → Relay: `signal.offer` / `signal.answer` / `signal.ice` / `signal.connectionState` / `turn.credential.request`
  - Relay → Host: `signal.offerForwarded` / `signal.iceForwarded` / `client.connectIntent`
  - Host → Relay: `signal.answer` / `signal.ice` / `host.pairingCode.create`
  - 両者: `turn.credential.issued`

ephemeral TURN credential (coturn `use-auth-secret` 互換):
- `username = "{unixExpiry}:{userId}"`、`password = base64(HMAC-SHA1(turnSharedSecret, username))`
- TTL は `turnCredentialTtlSec` (既定 300s)
- 発行 rate を per-user で limit

audit は signaling のメタ情報 (`userId`、`hostId`、方向、`signalType`、`outcome`) のみ。payload は記録しない。

検証:
- `services/relay/test/signaling.test.ts`: offer/answer/ice 往復、Host offline 時の pendingSignals buffer、TTL expire
- `services/relay/test/turn-credential.test.ts`: HMAC verify、rate limit
- `services/relay/test/auth.test.ts`: device session、pairing code redeem、HostAccess
- `grep -r "appendHostEvent\|host.event\|client.toHost" services/relay/src/` が 0 件であること

### Phase 3: Mac Host (node-datachannel 組み込み)

`apps/mac-host/package.json` deps:
- `node-datachannel` (`darwin-arm64` / `darwin-x64` / `linux-x64` / `win32-x64` の pre-built が npm 同梱)
- `ws` (signaling WebSocket client)
- `@codex-link/protocol` (workspace:*)

`apps/mac-host/src/`:
- `config.ts`: host.json schema + Keychain reference (`codex-link` から流用、broker 依存除去)
- `signaling-client.ts` (旧 `relay-client.ts` の置き換え): WSS 接続、`announce` (Host online を pairing code 発行用 metadata として通知、payload なし)、`createPairingCode`、`forwardSignal`、`receiveSignal`、`requestTurnCredential`。**`sendHostEvent` を作らない**
- `peer.ts`: PeerConnection per iPhone client (`{userId, deviceId}` keyed)。**Mac Host は answerer 固定** (iPhone から offer)。DataChannel 名 `codex-link-session`、reliable/ordered。`oniceconnectionstatechange` を signaling 経由で Relay へ報告して iPhone UI に反映。ICE servers は signaling 経由で取得した STUN + TURN credential を都度注入
- `session.ts`: Codex event sink を `peer.broadcastEvent(event)` に流す (broker 経路無し)
- `codex.ts`: `codex app-server` の loopback WebSocket 起動 (`$TMPDIR/codex-link-app-server.json` への port 書き出し)
- `codex-events.ts`: Codex app-server event → `CodexLinkEvent` 正規化 (`codex-link` から再利用)
- `capabilities.ts`: project list、Host capability advertise
- `cli.ts`: 起動順 = config 読み込み → signaling 接続 → `announce` → Codex app-server spawn → peer 待受
  - `codex-link host init` サブコマンドで pairing code 表示 + Keychain 書き込み + host.json 生成

再接続: ICE restart を peer.ts に実装。signaling 切断中でも既存 DataChannel が生きていればセッション継続。

検証:
- `apps/mac-host/test/peer.test.ts`: in-process loopback で offer/answer/datachannel 確立 (node-datachannel 2 個結線)
- `apps/mac-host/test/session.test.ts`: sink を `FakePeer` に差し替え、Codex event の broadcast を確認
- `apps/mac-host/test/signaling-client.test.ts`: signaling round trip

### Phase 4: iOS (WebRTC SwiftPM 組み込み)

`apps/ios/Package.swift`:
- `stasel/WebRTC` (XCFramework 配布、Apple silicon Mac + iOS device 両対応)

`apps/ios/Sources/CodexLinkIOS/`:
- `SignalingWebSocketClient.swift` (旧 `RelayWebSocketClient.swift` 置き換え): signaling 専用 WS client。`subscribeHost` / `restoreVisibleSession` 系を持たない
- `RelayMessages.swift`: signaling メッセージ型のみ (`signalOffer` / `signalAnswer` / `signalIce` / `turnCredentialIssued`)。`hostEvent` / `hostMessage` / `hostSubscriptionReady` を作らない
- `RelayCommands.swift` / `RelayActionEncoder.swift`: UIAction → DataChannel 直接送信 (`client.toHost` envelope を作らない)
- `PeerConnection.swift`: **iPhone は offerer 固定**。`RTCPeerConnection.offer()` → signaling → answer → ICE candidate 交換。DataChannel `codex-link-session` reliable/ordered
- `SessionProjection.swift`: 入力 source を DataChannel binary frame に (`applyDataChannelFrame(_ data:)`)。`codex-link` から再利用
- `SessionStartup.swift` / `SessionRestore.swift`: peer 確立後に `session.snapshot.request` を DataChannel で Mac Host に送り、Host が現状 projection を 1 メッセージで返す **replay-on-peer** パターン。Relay event replay は作らない
- `AppLifecycle.swift`: 起動 / 復元 / 再接続のオーケストレーション。`codex-link` から流用、broker 経路を削除
- `CodexLinkRootView.swift` / `CodexLinkUIState.swift`: UI。`codex-link` から流用、connection path 表示用 state を追加
- `LiveActivity.swift`: `codex-link` から流用

DataChannel frame: `CodexLinkSessionFrame` (sum type: `event(CodexLinkEvent)` / `snapshot(CodexLinkProjection)` / `ack(SequenceNumber)`)

ICE servers は **TURN credential 取得後** に peer 注入 (race 回避)。

`apps/ios/CodexLink.xcodeproj` の app target:
- Bundle ID: `dev.codexlink.ios` (将来 AppleStore 提出時に本番 ID へ)
- `Info.plist` の `CodexLinkRelayURL` 既定: `https://codex-link-p2p.kitepon.dynv6.net` (Simulator 開発時のみ `http://127.0.0.1:3000` でローカル Relay)

検証:
- `apps/ios/Tests/CodexLinkIOSTests/PeerConnectionTests.swift`: signaling mock + XCTest 内 RTCPeerConnection 2 個結線で DataChannel 疎通
- `apps/ios/Tests/CodexLinkIOSTests/ProjectionTests.swift`: DataChannel frame の decode と SessionProjection 更新

### Phase 5: TURN サーバー (coturn) 同居

`compose.yaml` に既に skeleton を入れた。実装でやること:
- `coturn` service 設定 (3478/udp+tcp + 49152-65535/udp range)
- `services/relay/turn/turnserver.conf`: `use-auth-secret`、`realm`、`external-ip`、`turns` 用 TLS cert (Caddy 同居)
- `TURN_SHARED_SECRET` を Relay と共有 (環境変数)
- Relay の `issueTurnCredential` が `username` / `password` を発行

ICE servers (Mac Host / iPhone が peer 構築時に注入):
- `stun:stun.l.google.com:19302`
- `turn:codex-link-p2p.kitepon.dynv6.net:3478` (kite サーバー)
- `turns:codex-link-p2p.kitepon.dynv6.net:5349` (TLS 経由)

検証:
- `turnutils_uclient` で疎通確認
- Relay 発行 credential が coturn に通る integration test (compose 起動 → curl)

### Phase 6: E2E 流路化と統合テスト

- `apps/mac-host/test/e2e-flow.test.ts`: signaling → peer 確立 → Codex event 流通の E2E
- compose 起動 (`docker compose up --build relay coturn`) → Mac Host (`pnpm --filter @codex-link/host start`) → iOS Simulator で iPhone app 起動 → QR pair → turn 発火

### Phase 7: Connection path 可視化 UX

- `apps/ios/Sources/CodexLinkIOS/CodexLinkUIState.swift` に `connectionPath: .direct | .stunReflexive | .turnRelayed | .connecting | .failed`
- `PeerConnection.swift` 内: `RTCPeerConnection.statistics(...)` を 5s 周期で取り、selected candidate pair の `candidateType` (host / srflx / relay) を `connectionPath` に map
- `CodexLinkRootView.swift`: Host header + Live Activity に status badge。TURN 経由時は黄色バッジ
- `CodexLinkPreviewCanvas.swift`: 3 状態追加

### Phase 8: docs 整合

- 実装が固まった段階で `CLAUDE.md` と `docs/` を読み直して整合チェック
- `grep -ri "broker\|event cache\|client\.toHost\|host\.event" docs/ CLAUDE.md src/` が **0 件** であること

### Phase 9: npm install 一発化

- `apps/mac-host/package.json` に `bin: codex-link-host`、`files` に dist、`prepublishOnly` で tsc build
- `codex-link host init` サブコマンドで pairing code 表示 + Keychain 書き込み + host.json 生成を CLI に内製
- Relay URL は `https://codex-link-p2p.kitepon.dynv6.net` をパッケージにハードコード、`--relay` で上書き可
- `node-datachannel` は pre-built なので追加の native build chain 不要 → 真の npm 一発
- 検証: クリーンな Mac VM で `npm i -g @codex-link/host` → `codex-link host init` → QR スキャン → turn 発火まで疎通

## 動作確認 (End-to-End)

1. `pnpm typecheck` (全 workspace)
2. `pnpm test` (全 workspace)
3. `swift test` (`apps/ios`)
4. `xcodebuild -project apps/ios/CodexLink.xcodeproj -scheme CodexLinkApp -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO`
5. `docker compose up --build relay coturn` → Mac Host 起動 → iOS Simulator → QR pair → turn 発火
6. 接続経路バッジで `direct` / `srflx` / `relay` を切り替えて確認 (Wi-Fi ↔ Cellular で実機検証)
7. `grep -ri "broker\|event cache\|client\.toHost\|host\.event" docs/ CLAUDE.md services/ apps/ packages/` が 0 件
8. Relay コンテナを再起動 → 再 pair で全機能復帰

## TODO / 既知の応急処置 (Phase 9 完走後に判明)

2026-05-14 の実機 iPhone 動作確認で**繋がるまで持っていけたが応急処置が混在**している. 残作業:

### iOS — pairing UX
- [x] **正規 QR pairing flow が未実装**. 現状は `apps/ios/App/CodexLinkApp.swift` の `OnboardingView` で
  Mac Host が出す 4 値 (userId / deviceId / sessionToken / hostId) を手で貼り付けるか、
  または `AutoConnect.fromBundledPairFile()` で `Documents/codex-link-pair.json` を読む dev-only 経路.
- [x] 手動 paste 時に `Universal Clipboard` が同期しない事故が頻発. 本番ユーザーには破綻する.
- [x] **やるべき**: 既存の `NSCameraUsageDescription` を使って QR scanner を入れる. Mac Host CLI が
  `codex-link-host pair` で発行する pairing code + `userId`/`hostId` を QR にして Mac の端末に
  表示し、iPhone のカメラで読み取る. iPhone は読み取った値で `/api/device-session/register` を
  叩き直して fresh credentials を取り、connect する.

  → 2026-05-14 実装: Mac CLI 側は `qrcode-terminal` で payload `{v:1, relayUrl, pairingCode, hostId}`
  を QR 表示. iOS 側は `OnboardingView` を QR scanner + `PairingFlow.exchange()` (register → pair)
  に置き換え.

### iOS — 接続経路バッジの妥当性
- [x] `[CodexLinkRootView](apps/ios/Sources/CodexLinkIOS/CodexLinkRootView.swift)` の `pathBadge` は
  `phase == .peerOpen` で「接続済」(緑) をデフォルトで出し、`connectionPath` の確定後に
  「直結」「中継」を上書きする実装. これは BOOTSTRAP.md 当初設計の「path 単独 ↔ UI」とズレている.

  → 2026-05-14 修正: pathBadge は connectionPath だけを唯一のソースにし、phase=.error のみ赤
  "エラー" で上書きする実装に変えた.
- [x] 同 [AppLifecycle.swift](apps/ios/Sources/CodexLinkIOS/AppLifecycle.swift) で `didChangePath` が
  no-op だった (= path が UI まで届いてなかった) のを `@Published connectionPath` に配線して直した.
- [x] [PeerConnection.swift](apps/ios/Sources/CodexLinkIOS/PeerConnection.swift) に BOOTSTRAP.md 当初
  設計の **stats poller (5s 周期)** が未実装だったので 2s 周期で追加した.

### iOS — 診断ログの整理
- [x] `apps/ios/App/CodexLinkApp.swift` の `diag(_)`、`apps/ios/Sources/CodexLinkIOS/AppLifecycle.swift`
  の `fwDiag(_)`、`PeerConnection.swift` の `pcDiag(_)`、`SignalingWebSocketClient.swift` の
  `sigClientLog(_)` の **4 ヶ所**で `NSLog` + `Documents/codex-link-debug.log` への file writer を
  入れている. 実機 debug で iOS unified log が見えなかったので入れた経緯. 本番には不要.
- [x] **やるべき**: `#if DEBUG` でガード、または完全に削除して os_log + Console.app 経由に統一.

  → 2026-05-14 実装: 4 関数の本体を `#if DEBUG` で囲み、Release では no-op に. PeerConnection /
  SignalingWebSocketClient 内に散らばっていた裸の `NSLog("[codex-link] ...")` も全部 pcDiag /
  sigClientLog 経由に統一.

### Mac Host — peer の自動 cleanup
- [x] ICE が `failed` で長時間張り付いた peer が `addRemoteCandidate_failed` を無限に warn し続け、
  さらに新規 iPhone 接続を受けると Mac Host が**正常に応答できなくなる**現象を確認した
  (2026-05-14 の実機 debug で再現).
- [x] 暫定対処: Mac Host プロセスを再起動 (`kill && start`).
- [x] **やるべき**: `apps/mac-host/src/peer.ts` の `PeerManager` に「`state=.failed` が N 秒継続した
  peer を close + state から削除」「`signaling_welcome` 再受信時に保持中の peer を全消去」の
  どちらか (両方が望ましい) を実装. unit test も追加.

  → 2026-05-14 実装: 両方入れた. `PeerEntry.failedSince` を `state==failed` 入る瞬間に記録し、
  stats loop の各 tick で `pruneFailedPeers()` が `failedCleanupMs` (既定 10s) 超過した peer を
  close + delete. cli.ts の `onWelcome` で `dropAllPeers()` を呼び、再 welcome 時に保持中の
  peer を全消去. 3 件の unit test を peer.test.ts に追加.

### iOS — 配布パス
- [x] `apps/ios/App/CodexLinkApp.swift` の `AutoConnect.fromBundledPairFile()` は
  `xcrun devicectl device copy to ... Documents/codex-link-pair.json` で dev 機材から push する
  経路. End user は使えない.
- [x] **やるべき**: 上記 QR pairing が入ったらこの経路は削除して良い. dev 用に残すなら `#if DEBUG`.

  → 2026-05-14: `#if DEBUG` で完全に囲み、Release ビルドからは fromBundledPairFile() ごと消える
  ようにした. QR pairing 経路が安定したら DEBUG ごと削除して良い.

### WS フレーム形式
- [x] `SignalingWebSocketClient.send` を **binary frame** から **text frame** に変えた
  (`URLSessionWebSocketTask.Message.string`). Node `ws` ライブラリはどちらも受けるので必須ではないが、
  人間が `wireshark` 等で覗ける利点と、relay-side の他 client (Mac Host CLI) と揃える意味で text 推奨.

  → 完了済の事実メモ (commit 49d3abe で text frame 化).

### iOS Simulator runtime
- [x] 実機 iPhone を iOS 26.5 に上げたら `xcodebuild` が "iOS 26.5 is not installed" でビルド不能になり、
  `xcodebuild -downloadPlatform iOS` で iOS 26.5 Simulator runtime (~8.5 GB) を落として解消.
- [x] **やるべき**: `docs/deploy.md` または開発環境 setup ドキュメントに「iPhone iOS バージョン更新後は
  対応 Simulator runtime を `xcodebuild -downloadPlatform iOS` で入れる」と明記.

  → 2026-05-14: docs/deploy.md に「開発環境メモ → iPhone 実機ビルド時の Simulator runtime」
  セクションを追加.

## リスク / 留意点

- **`node-datachannel` の Windows arm64 pre-built は 2026-05 時点で未提供**。x64 Windows と Intel/Apple silicon Mac は問題なし
- **iOS の `stasel/WebRTC` XCFramework は ~30 MB**。app binary 肥大は AppStore 提出時に検討 (今回 plan 対象外)
- **TURN credential ローテーション**: `turnSharedSecret` を変えると現行接続中の peer 全切断。graceful rotation は MVP 後
- **`../codex-link/` の `/etc/hosts` 記述 (ヘアピン NAT)** は kite 開発環境固有なので、本リポジトリの docs / セットアップに **持ち込まない**
- **AppleStore 配布の Live Activity 互換** は MVP 後

## 質問と判断

新セッションが詰まった時に kite に確認すべき項目:
- Bundle ID / Team ID / 配布証明書 (AppleStore 用)
- 本番 Relay デプロイ手順 (compose、Caddy reverse proxy、coturn の TLS cert)
- `kitepon.dynv6.net` の sub-domain (`codex-link-p2p.kitepon.dynv6.net`、HTTPS + TURN を 1 ホスト名に同居) の DNS 設定
- iPhone app の dev provisioning が個人 Team (TPWX489GV4) のままで進めるか
