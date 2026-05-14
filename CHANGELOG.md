# Changelog

Phases 10〜14 (= MVP roadmap) で実装された変更を時系列でまとめる. Phase 1〜9
までは BOOTSTRAP.md に集約済.

## Unreleased / dogfood (Phase 14c)

Phase 14c (実機 7 日 dogfood) は user 側のタスク. 完了した時点で `0.1.0-mvp`
としてタグ付け. 途中で見つかった bug fix は順次追加.

## Phase 14: dogfood-readiness + 安定化

### feat(ios): Settings に Share debug log ボタン (`92d7641`)
- `Documents/codex-link-debug.log` を AirDrop/Mail/Files で 1 tap export.
- UIActivityViewController を SwiftUI でラップ. macOS では no-op (SwiftPM 互換).

### feat(ios): peer .failed 10s 自動再接続 + Settings に Reconnect ボタン (`2b7b60f`)
- AppLifecycle.reconnect(reason:): signaling.stop + peer.close → 200ms 待機 →
  signaling.start で完全再接続.
- peer.didChangeState(.failed) で failedSince を記録、10s 後にチェックして
  自動 reconnect. connected/completed に戻ったらキャンセル.
- Settings に手動 Reconnect ボタン.

### fix(ios): scenePhase 監視で background → foreground 自動再接続 (`5807b18`)
- ContentView.onChange(of: scenePhase) で .active 復帰時に
  lifecycle.resumeIfNeeded() を呼ぶ.
- 画面 lock 後にアプリ開いて「接続中…」固まり問題の根本対処.

### docs: Phase 14c の dogfood-runbook (`b95e277`)
- 7 日間の日次 checklist (7 観点) + 不具合発見時のレポートテンプレ.

### test(mac-host): dogfood-sim — 5 件の高負荷シナリオ自動テスト (`557906c`)
- 1000 連続 assistant.delta → state corruption なし.
- 10 thread × 50 delta → per-thread state 分離.
- approval roundtrip → pending state クリーンアップ.
- 空 state snapshot_request → valid empty projection.
- 2 thread 100 turn 交互 → 両方 completed.

### Phase 14a + robustness 強化 (`77717b8` + `b8e4483`)
- launchd plist + install-launchd.sh.
- ResilientCodexClient: codex app-server crash 時の指数バックオフ自動 respawn.
- Live Activity 500ms debounce: streaming delta で ActivityKit を叩き過ぎない.
- Transcript / Timeline 500 件 cap: 長 session の memory 肥大防止.

### Phase 14b: CLI flag + README + 細部修正 (`3b49f07`)
- `codex-link-host start --use-null-codex`: Codex 未 install 環境向け.
- codex-client constructor parameter property を Node strip mode 対応に書き換え.
- protocol session.test の sequence/timestamp を SessionFrame に移行 (3 ヶ所).

## Phase 13: Live Activity (iOS 17+)

### `790594d` 後半
- ActivityKit (`CodexLinkTurnActivityAttributes` + `ContentState`).
- WidgetKit (`CodexLinkTurnLiveActivityWidget`): Dynamic Island の expanded /
  compactLeading / compactTrailing / minimal + Lock screen view.
- CodexLinkLiveActivityController (actor) で start/update/end の整合.
- CodexLinkDeepLink (codexlink:// scheme) で widget tap → app deep link.
- project.yml に CodexLinkWidget (type: app-extension) を追加し、CodexLinkApp
  の dependencies に embed=true.
- NSSupportsLiveActivities + CFBundleURLTypes (codexlink) を Info.plist に.
- 全体の deployment target を iOS 17 に bump.

## Phase 12: iPhone UI 親リポ同等まで再構築

### `790594d` 前半
- CodexLinkRootView の header に Threads ボタン + Settings ボタン + Status
  indicator (実行中 / 承認待ち / 待機) + pathBadge.
- ScrollViewReader による Auto-scroll-to-bottom.
- TimelineEntry を ActivityRow 相当の描画 (icon + 色 + label + detail, status
  別の色分け).
- TranscriptRow を role 別配色.
- ApprovalCard を 4-way decision (accept / accept_for_session / decline /
  cancel) の動的ボタンに対応.
- ThreadsSheet (Projects + Threads 階層 List).
- SettingsSheet (Host info + Connection + Diagnostics).

## Phase 11: Session protocol を broker 版完全互換に

### TS (`d31553b`) + iOS (`6e496b0`)
- ProjectId / TurnId / ItemId branded types を追加.
- TurnStatus を broker 互換: idle / running / waiting_for_approval / completed
  / failed / canceled.
- ApprovalKind を 4 値: command_execution / file_change / network / user_input.
- ApprovalDecisionKind: accept / accept_for_session / decline / cancel.
- ApprovalRequest に title / detail / availableDecisions / turnId / itemId.
- ProjectRef / ThreadRef / TurnRef / HostChatGptAccount を新規追加.
- TranscriptItem (id + role + text). TimelineEntry (status / detail).
- CodexLinkEvent から sequence/timestamp を抜き、SessionFrame 側に移動.
- 新規 event variants: host.account.updated / diagnostic.reported.
- UISubmitTurn に projectId 必須化. UICancelTurn に turnId 追加.
  UIResumeThread 新規追加.
- LiveActivityState 型を export.
- iOS の Identifiers / SessionTypes / SessionProjection / AppLifecycle を新
  protocol に完全追従.

## Phase 10: Mac Host から Codex に実 wire

### `d31553b`
- @codex-link/codex-client (438 行 JSON-RPC 2.0 client + 85 generated types)
  を broker から port. generated/ の relative import に .js 拡張子全付.
- startCodex() で `codex app-server --listen ws://127.0.0.1:0` を spawn,
  stderr の listen banner から port を取得して WS 接続.
- codex-events.ts (853 行) を broker から port. notification + server request
  → CodexLinkEvent 正規化.
- SessionManager を broker 流で書き直し: handleCodexNotification /
  handleCodexServerRequest / dispatchUIAction / buildProjection / pendingApprovals.
- NullCodexClient を CodexAppServerClient 実装に書き直し (emitNotification /
  emitServerRequest テストフック付).
- cli.ts で SpawnedCodexClient or NullCodexClient を選べる起動.

## docs

### `87b889b`
- docs/roadmap.md: Phase 10-14 を BOOTSTRAP.md と同じ density で記述.
  各 Phase の含むタスク / 含まないもの / 検証 Done 基準 / 隣リポ参照点を明記.
  MVP 後 (Phase 15-18) のスコープも切り出し.
- CLAUDE.md / BOOTSTRAP.md / docs/mvp-plan.md を Phase 1-9 完走済 + Phase 10-
  14 への参照に再整理.

## Phase 9 完走時点までの作業 (history)

[BOOTSTRAP.md](BOOTSTRAP.md) と Phase 1-9 の commit log 参照. 主要な節目:
- WebRTC P2P 配管 (QR pairing + DataChannel + TURN credential).
- iOS pathBadge の prflx 対応.
- Mac Host PeerManager stale peer 自動 cleanup.
- iOS 診断ログ #if DEBUG ガード.
