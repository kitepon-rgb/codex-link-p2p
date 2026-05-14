# MVP Plan

実装は [BOOTSTRAP.md](../BOOTSTRAP.md) に詳細展開。本ドキュメントは Phase の俯瞰用。

## 現状サマリ (2026-05-13 時点)

| Phase | 内容 | 状態 |
|-------|------|------|
| 1     | Protocol 分割 (rendezvous / session) | 完了. lint guard 込み |
| 2     | Relay (HTTP + WS signaling + TURN cred 発行 + payload-blind) | 完了. 105 tests |
| 3     | Mac Host (config / token-store / signaling-client / peer / codex / session / cli) | 完了. 63 tests (E2E 含む) |
| 4     | iOS (Swift protocol mirror / SignalingWS / PeerConnection / SessionProjection / AppLifecycle / UI) | 完了. 24 swift tests + 1 skip |
| 5     | coturn 同居 (compose + use-auth-secret + verify script) | 完了 |
| 6     | E2E (in-process Relay + Mac Host + raw iPhone offerer) | 完了 |
| 7     | Connection path 可視化 (direct/srflx/relay バッジ) | 完了 (Phase 4 と同時) |
| 8     | docs 整合 + ESLint guard 確認 | 進行中 |
| 9     | npm 一発配布 (`@codex-link/host`) | 未着手 |

## Phase 1: Protocol 分割と signaling 型定義

`packages/protocol/src/rendezvous.ts` と `session.ts` を分離。`services/relay` は session を import 禁止。
新規 signaling 型: `RtcSignalOffer` / `RtcSignalAnswer` / `RtcIceCandidate` / `RtcConnectionState` / `TurnCredential`。

## Phase 2: Relay 実装 (signaling-only)

HTTP: `host-bootstrap` / `device-session` / `device-session/pair`。
WS: signaling envelope の中継、TURN credential 発行、pairing code 発行 / redeem。
`pendingSignals` (TTL 30s) で Host offline 中の signal を buffer。
**`client.toHost` / `host.event` / event cache を一切作らない**。

## Phase 3: Mac Host 実装

`node-datachannel` 組み込み。`peer.ts` (answerer 固定)、`signaling-client.ts`、Codex spawn と event 正規化。
ICE restart で再接続。`codex-events.ts` は `../codex-link` から流用 (broker 依存除去)。

## Phase 4: iOS 実装

`stasel/WebRTC` 組み込み。`PeerConnection.swift` (offerer 固定)、`SignalingWebSocketClient.swift`、replay-on-peer パターン。
`SessionProjection.swift` の入力 source を DataChannel binary frame に。

## Phase 5: TURN サーバー (coturn) 同居

`compose.yaml` に coturn service。`use-auth-secret` で Relay と HMAC shared secret を共有。
ICE servers に Google STUN + 自前 turn / turns を併記。

## Phase 6: E2E 流路化と統合テスト

compose 起動 → Mac Host → iOS Simulator で turn 発火。
`apps/mac-host/test/e2e-flow.test.ts` を新規。

## Phase 7: Connection path 可視化 UX

`RTCPeerConnection.statistics(...)` を 5s 周期で取り、`connectionPath` を UI に反映。
TURN 経由時は黄色バッジ。

## Phase 8: docs 整合

ESLint guard (`eslint.config.js`) が broker トークン (`client.toHost` / `host.event` /
`host.subscription.ready` / `appendHostEvent` / `readHostEventReplay` /
`sendHostEvent` / `routeToHost` / `subscribeHost`) を services/relay/src の
**実コード** で検出すれば必ず lint fail する。これが canonical enforcement。

人手チェック:
- `pnpm lint` が green であること。
- `grep -ri "broker\|event cache\|client\.toHost\|host\.event"` の結果は
  **コメント / docs / 鉄則の言及のみ** で、実コードの identifier / 文字列
  リテラルとしての使用が無いことを目視確認する.
- CLAUDE.md / BOOTSTRAP.md / docs/ の記述が実装と整合していること.

## Phase 9: npm install 一発化

`apps/mac-host/package.json` に `bin: codex-link-host`、`prepublishOnly` で tsc build。
`codex-link host init` サブコマンドで pairing code 表示 + Keychain 書き込み + host.json 生成。
Relay URL を npm package にハードコード (`--relay` で上書き可)。
Windows Host も同一 npm package を将来想定 (`apps/win-host/` で `peer.ts` をシェア)。

## MVP の終了条件

1. `pnpm typecheck` と `pnpm test` が全 workspace で通る
2. `swift test` (`apps/ios`) が通る
3. compose 起動 → Mac Host 起動 → iOS Simulator で QR pair → turn 発火 → Codex 応答が iPhone に DataChannel 経由で届く
4. 接続経路バッジで `direct` / `srflx` / `relay` が切り替わる (Wi-Fi ↔ Cellular)
5. `pnpm lint` (ESLint payload-blind guard) が green. broker トークンの
   識別子 / プロパティアクセス / 文字列リテラル使用が **実コード** で 0 件
   (コメント / docs での言及は許容).
6. クリーンな Mac VM で `npm i -g @codex-link/host` → `codex-link host init` → 動作

## MVP 後 (本リポジトリの将来)

**Phase 1〜9 で完了済の応急処置** (詳細は [BOOTSTRAP.md](../BOOTSTRAP.md#todo--既知の応急処置-phase-9-完走後に判明)):

- [x] iOS QR pairing UI
- [x] Mac Host PeerManager の stale peer 自動 cleanup
- [x] iOS 診断ログ (`diag` / `fwDiag` / `pcDiag` / `sigClientLog`) の `#if DEBUG` ガード

**MVP の残作業は [docs/roadmap.md](roadmap.md) (Phase 10〜14)** に集約:
- Phase 10: Mac Host → Codex 実 wire (`SpawnedCodexClient` + `codex-events.ts`)
- Phase 11: Session protocol 完全化 + snapshot / ack / approval 4 種
- Phase 12: iPhone UI を親リポと同等まで再構築 (Threads sheet / Settings / ConversationFeed / ApprovalBanner / Composer)
- Phase 13: Live Activity (iOS 17+, Dynamic Island + Lock screen)
- Phase 14: 実機 dogfood + launchd 化 + 安定化

**MVP 後** (= MVP 完成後の next phase. roadmap.md 別セクション):

- [ ] Phase 15: Windows Host の正式追加 (`apps/win-host/`)
- [ ] Phase 16: AppleStore 配布対応 (Bundle ID 本番化、配布証明書、プライバシー方針、Live Activity 審査互換)
- [ ] Phase 17: Relay state の永続化 / Device credential / TURN credential のローテーション
- [ ] Phase 18: 多人数 / multi-host (1 user が複数 Mac を pair)
