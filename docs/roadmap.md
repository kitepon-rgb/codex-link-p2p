# Roadmap (MVP 完成までの計画書)

`codex-link-p2p` の **Phase 1〜9** は [BOOTSTRAP.md](../BOOTSTRAP.md) に書かれていて、
**WebRTC P2P 配管 (QR pairing + DataChannel) が iPhone⇄Mac で通る** ところまでで完走済.

このドキュメントはそこから先 **MVP 完成までの Phase 10〜14** の計画書. MVP の定義と、各
Phase で何を作る / 何を作らないかをここに集約する.

---

## MVP 定義

ユーザ (kite) 確定 (2026-05-14):

> 親プロジェクト ([../codex-link/](https://github.com/kitepon-rgb/codex-link)) から引き継いだ
> **iPhone アプリ UI を Live Activity 含めて完全再現**し、そのアプリから **Codex の
> セッションと完全に chat 同期**できる. これができなければゴミ.

つまり MVP に **入る** のは:
- iPhone から Codex に prompt 送信 / assistant 応答受信
- tool 実行の **approval** 操作 (command / patch / file_write / network の 4 種)
- **session snapshot** 復元 (起動直後 / 再接続後)
- 親リポと同等の iPhone UI (Threads sheet, ConversationFeed, ApprovalBanner, Composer,
  Settings sheet, status badge, streaming 表示)
- **Live Activity** (Dynamic Island + Lock screen, iOS 17+)
- Mac Host が Codex `app-server` に実 wire (= `NullCodexClient` の置き換え)

MVP に **入らない** のは (= MVP 後 phase):
- Windows Host (`apps/win-host/`)
- AppleStore 配布対応 (Bundle ID 本番化、配布証明書、プライバシー方針、Live Activity の
  AppStore 互換性審査)

つまり MVP は **kite が自分の iPhone と Mac で実用上問題なく毎日使えるところまで**.

---

## 守るべきアーキ鉄則 (再掲)

BOOTSTRAP.md / CLAUDE.md と同じ. Phase 10 以降でも壊さない:

- Relay は payload を観測しない. `client.toHost` / `host.event` / event cache を作らない
- データ平面は WebRTC DataChannel で iPhone⇄Mac 直接, Relay を通さない
- `services/relay` から `@codex-link/protocol/session` を import しない
- Host は inbound port を持たない
- iPhone app は raw Codex app-server JSON-RPC を直接話さない. `packages/protocol/session` 経由のみ
- 隣リポ ([../codex-link/](https://github.com/kitepon-rgb/codex-link)) は **参照のみ**.
  ファイルを再利用する時はコピーして broker 依存 (`appendHostEvent`, `client.toHost`,
  `host.event`, event cache 関連) を完全に除去する

---

## 現状 (Phase 9 完走時点)

実装済 (= Phase 10 で活かす):
- WebRTC P2P 配管: QR pairing flow / `/api/device-session/{register,pair}` / signaling /
  TURN credential / DataChannel ([commit `13ffaa3` / `80604ef`](../README.md))
- protocol 型定義 (`packages/protocol/src/{rendezvous,session}.ts`)
- iPhone 側 SessionProjection の apply ロジック (event → transcript / streamingAssistant /
  pendingApproval)
- Mac Host PeerManager + SessionManager の skeleton (`apps/mac-host/src/{peer,session}.ts`)
- pathBadge (connectionPath を唯一のソースに、`prflx` を NAT 越え扱い)

未実装 (= Phase 10〜14 で潰す):
- Mac Host が Codex に繋がっていない (`NullCodexClient` のみ)
- Mac Host の `codex-events.ts` (Codex notification → `CodexLinkEvent` 正規化) が無い
- snapshot request/response が DataChannel 上で往復しない (= 起動直後の Projection が空)
- ApprovalKind が 4 種揃ってない可能性 (`patch` と `command` が broker 版と微妙にずれている)
- iPhone UI が **placeholder レベル** ("Waiting for Host…" だけ. 親リポの 2000 行の
  CodexLinkRootView は何も移植されていない)
- Live Activity が **完全に未実装** (`apps/ios/Sources/CodexLinkIOS/LiveActivity.swift` 自体無い)
- Settings sheet / Threads sheet / Composer / 状態 badge / 再接続 banner どれも無い
- 親リポ側にあった ConversationFeed (LazyVStack + scroll + typing indicator) も無い

---

## Phase 10: Mac Host から Codex に実 wire

**ゴール**: Mac Host が `codex app-server` プロセスを spawn して JSON-RPC で通信し、Codex の
notification を `CodexLinkEvent` に正規化して DataChannel に流せるようになる. iPhone の
SessionProjection に、実 Codex から来た event が反映される.

### 含むタスク
- [ ] `apps/mac-host/src/codex.ts` の `SpawnedCodexClient` を完成
  - `spawn('codex', ['app-server', '--listen', 'ws://127.0.0.1:0'])` で起動
  - stdout から listen port を拾う (regex / 構造化 stdout どちらでも)
  - WebSocket JSON-RPC 2.0 client を実装 (素直に `ws` を使う)
  - 送信 method: `codex.turn.start` / `codex.turn.steer` / `codex.turn.interrupt` /
    `codex.approval.resolve` / `codex.thread.restore` / `codex.thread.list`
  - 受信 notification を `CodexAppServerEvent` 型で emit
  - 再起動ロジック (Codex 落ちたら指数バックオフ)
  - graceful shutdown (`SIGTERM` 送って exit 待ち)
- [ ] `apps/mac-host/src/codex-events.ts` を新規作成 (隣リポの同名ファイルがそのまま参考)
  - Codex notification (`thread/started`, `turn/started`, `item/agentMessage/delta`,
    `item/started`, `item/commandExecution/requestApproval` 等) を `CodexLinkEvent` に
    マップ
  - approval kind は 4 種 (command / patch / file_write / network) で揃える
  - 旧フォーマット (`execCommandApproval`, `applyPatchApproval`) の互換マッピング
  - vitest で 14+ 件のサンプル notification → CodexLinkEvent 変換テスト
- [ ] `apps/mac-host/src/session.ts` の `SessionManager` を `SpawnedCodexClient` を受け
  取って動かせるように配線
  - 既存の `handlePeerFrame` / `handleCodexEvent` を実装
  - sequence 採番 (peer ごとに `lastEmittedSeq` を保持)
- [ ] cli.ts で起動 flag (`--codex-cmd /path/to/codex` 等) を受けて `SpawnedCodexClient`
  に渡せるように
- [ ] vitest 統合テスト: stub の Codex (echo socket) を立てて、CLI 経由で peer に CodexLinkEvent
  が届くまでを検証

### 含まないもの (scope guard)
- iPhone UI の改修 (Phase 12)
- Live Activity (Phase 13)
- 旧 broker 経路の互換維持 (Relay 経由 routing を作らない)

### 検証 / Done 基準
1. `pnpm --filter @codex-link/host test` で `codex-events.test.ts` (新規) と
   `codex.test.ts` が green
2. ローカルで `codex app-server` を spawn できる環境 (Codex 配布済) で、Mac Host を起動 →
   iPhone から QR pair → 1 つ thread を作成し prompt を投げる → iPhone の transcript に
   user message + assistant 応答が表示される
3. tool 実行で approval が出る prompt を投げ、iPhone に approval が出る (UI ボタンは
   Phase 12 で繋ぐので、ここでは event の到達確認まで)

### 隣リポ参照点 (コピー候補)
- `apps/mac-host/src/codex-events.ts` (broker 版) — そのまま import 排除してコピー可
- `apps/mac-host/src/codex.ts` の `startMacHostCodexLoopbackWebSocket()` 周辺 — `client.toHost`
  に書き出してる部分を `peerManager.broadcastFrame` に差し替えるだけで動くはず

---

## Phase 11: Session protocol の完全化 + snapshot/ack

**ゴール**: DataChannel 上で流れる全 frame 種 (event / ui_action / snapshot_request /
snapshot_response / ack) が iPhone⇄Mac で正しく往復し、起動直後 / 再接続後でも projection
が同期する.

### 含むタスク
- [ ] `packages/protocol/src/session.ts` を broker 版と比較し、不足 / ズレている event /
  ApprovalKind / UIAction を補強
  - approval decision を 4-way (accept / accept_for_session / decline / cancel) に拡張するか
    2-way (approved / denied) に留めるかを決める (broker 版に合わせる方が UI 移植が楽)
  - ApprovalRequest の payload を 4 kind × そのコンテキスト (command 内容 / patch diff /
    file path / network domain) で揃える
  - TimelineItemKind / TimelineStatus を broker 版と alignment
- [ ] Mac Host の `SessionManager` に snapshot 機能を実装
  - iPhone から `snapshot_request` を受けたら現在の Projection (hostId / capabilities /
    projects / threads / latestSequence) を `snapshot_response` で返す
  - DC open 直後にも能動的に push (= "welcome snapshot") するか、要求ベースに留めるかを
    決める. broker 版は要求ベースなので踏襲推奨
- [ ] iPhone 側 `AppLifecycle.requestSnapshot()` 実装
  - DC open delegate で発火 (既に呼び出しは入っている)
  - response 到着で `projection.applySnapshot()`
- [ ] ack frame: iPhone が受信した event の sequence 番号を Host に投げ返す (Host 側で
  「未到達 event を再送するか」の判断材料にする. ただし MVP では Host は再送しない)
- [ ] UIAction → Codex command 変換を Mac Host で実装
  - `submitTurn` → `codex.turn.start`
  - `respondApproval` → `codex.approval.resolve`
  - `cancelTurn` → `codex.turn.interrupt`
  - `selectProject` → `codex.thread.list` (project filter)
- [ ] vitest で round-trip テスト (frame 全種、approval 4 種、snapshot)

### 含まないもの
- ack を見て Host から再送する仕組み (MVP 後. DC 切れたら iPhone が再 snapshot 取る方が単純)
- multi-host pairing (今回は 1 user = 1 host を前提)

### 検証 / Done 基準
1. `pnpm test` 全 package green (protocol の wire compatibility test も含む)
2. Mac Host 再起動 / iPhone reconnect 後、snapshot で thread 一覧と transcript が復元される
3. Approval 4 種すべてが iPhone まで届き、reply が Codex まで戻る

### 隣リポ参照点
- `apps/mac-host/src/session.ts` (broker 版) — snapshot 構築ロジックを参考
- `packages/codex-link-types/` (broker 版にあるかも) — 型定義の zod スキーマ

---

## Phase 12: iPhone UI を親リポと同等まで再構築

**ゴール**: 親リポ ([../codex-link/](https://github.com/kitepon-rgb/codex-link)) の
`CodexLinkRootView` を中心とした SwiftUI 画面を、broker 依存を除去しながら p2p に移植.
"Waiting for Host…" placeholder から、実際に毎日使える chat UI まで持っていく.

### 含むタスク
- [ ] `CodexLinkRootView.swift` を broker 版と同等構造に再実装
  - **Header**: SessionTitleView (title + subtitle + status badge) + pathBadge
  - **Conversation feed**: LazyVStack + ScrollViewReader での auto-scroll
    - `MessageRow` (user / assistant bubble. role に応じて配色)
    - `ActivityRow` (timeline 1 item. icon + label + status dot + expandable detail)
    - `TypingIndicator` (turn 実行中の 3 dot animation)
  - **Approval banner**: 常時可視. `ApprovalDetailSheet` で詳細表示 + 4-way 操作 (or 2-way)
  - **Composer**: TextField (multiline) + Send / Stop / Cancel ボタン
- [ ] `ThreadsSheet`: Projects と Threads の階層リスト. 新規 thread 作成、既存 thread 切替
- [ ] `SettingsSheet`: Host info / 接続診断 / build info / device 解除
- [ ] `InlineBanner`: 再接続中 / TURN 経由中 / Codex 落ちた 等を上部に表示
- [ ] `CodexLinkUIState.swift` の selection / connection state enum を broker 版の 7 状態
  (`disconnected` / `connecting` / `connected` / `reconnecting` / `restoring` / `restored` /
  `failed`) に揃える
- [ ] `AppLifecycle.swift` の状態管理を新 UI に対応
- [ ] Onboarding (QR scan) は既存実装を維持. PairFlow 全体 (paired hosts list, manual
  code entry) は MVP では不要 (= 1 device = 1 host 前提なので)
- [ ] swift test で SessionProjection apply の追加ケース (Timeline / Approval 4 種)

### 含まないもの
- AppleStore 配布用の asset (icon, launch screen の本番版)
- Live Activity (Phase 13)
- Settings の中の高度な diagnostics (例: WebRTC stats dump UI)

### 検証 / Done 基準
1. iPhone 実機で 1 つの thread に 10 ターン以上 chat して、UI が壊れない (transcript の
   auto-scroll, streaming delta, approval 操作, thread 切替)
2. swift test 全件 green
3. xcodebuild iOS Simulator build SUCCEEDED
4. dark mode / dynamic type を変えてもクラッシュしない

### 隣リポ参照点 (再利用ファイル)
- `CodexLinkRootView.swift` — 2000+ 行を分割しながら移植
- `SessionProjection.swift` — p2p 版にすでに簡易版がある. broker 版 apply ロジックを diff して取り込み
- `CodexLinkUIState.swift` — enum 定義移植
- `CodexLinkPreviewCanvas.swift` — Xcode preview 用. そのまま使える
- `DeviceSession.swift` — Keychain 永続化. 現状 p2p は user defaults だが将来 keychain に揃える
  (MVP 後でも可)

---

## Phase 13: Live Activity 実装 (iOS 17+)

**ゴール**: Codex が実行中 / approval 待ち / 完了 / 失敗の状態を **Dynamic Island + Lock screen**
に表示し、app を foreground にしなくても進捗を把握できる.

### 含むタスク
- [ ] **新規 widget extension target** を XcodeGen に追加
  - `apps/ios/Widget/` ディレクトリ
  - Info.plist で `NSExtension` / `NSExtensionPointIdentifier = com.apple.widgetkit-extension`
  - Bundle ID は app の suffix (`dev.codexlink.ios.LiveActivity`)
- [ ] `LiveActivity.swift` を新規作成
  - `CodexLinkTurnActivityAttributes: ActivityAttributes` 定義
    - immutable: hostId, projectId, threadId, turnId, deepLinkURL
    - ContentState: hostName, projectName, status (TurnStatus enum), latestText, approvalRequired
  - `ActivityConfiguration` で **Lock screen view** + **Dynamic Island** 各 region (expanded
    / compactLeading / compactTrailing / minimal)
- [ ] `CodexLinkLiveActivityController` を `CodexLinkIOS` package に実装
  - AppLifecycle の event 後に `sync(projection, selection)` を呼ぶ
  - visibility 判定: turn 実行中 or approval 待ち → `.active`、それ以外 → `.hidden`
  - `.update(state:)` でリアルタイム更新
  - app が完全に閉じても Live Activity だけは残るので、event を受け取れる経路 (background
    push or APNs) は MVP 後. **MVP は foreground / background 短時間で動けば OK**
- [ ] `AppLifecycle` から `Controller.sync()` 呼び出し
- [ ] iOS 17 未満では Live Activity を **完全無視** (`#available(iOS 17.0, *)`)
- [ ] Deep link `codexlink://thread/<threadId>?turn=<turnId>` を Info.plist の URL scheme に追加
- [ ] swift test で controller の visibility 判定をユニットテスト

### 含まないもの
- APNs / background push (= app 完全 termination 後の更新). MVP 後
- WidgetKit の Home Screen Widget (= Live Activity と別物). MVP 後
- iOS 16 への back-port

### 検証 / Done 基準
1. iPhone 実機 (iOS 17+) で turn を投げる → Dynamic Island に `Running` が出る
2. approval が来る → Dynamic Island が `Approve` に切替、tap で app が deep link 経由で開く
3. turn 完了 → Lock screen の Live Activity が `Done` で数秒残り、自動 dismiss
4. swift test で `LiveActivityController` の状態遷移ロジックが green

### 隣リポ参照点
- `apps/ios/Sources/CodexLinkIOS/LiveActivity.swift` (broker 版) — そのまま import 排除して
  コピー可
- broker 版の `apps/ios/Widget/` (存在すれば) ディレクトリ構成

---

## Phase 14: 実機 dogfood + 安定化

**ゴール**: kite が毎日使えるレベルまで edge case を潰す. **MVP 完成のゴールテープ**.

### 含むタスク
- [ ] 実機 (iPhone 16 Pro Max + Mac) で **1 日通常業務として使い**、不具合を issue として記録
- [ ] 再接続 edge case
  - Wi-Fi ↔ Cellular 切替時の signaling reconnect + peer 再 establish (`signaling_welcome`
    再受信で `peerManager.dropAllPeers()` 経由 cleanup は実装済)
  - app background → foreground 復帰時の UI / activity 再同期
  - Mac Host プロセス再起動時の iPhone 側の挙動
- [ ] **複数 thread** をまたいだ操作 (Threads sheet で切替、戻し、新規作成)
- [ ] 長い transcript (100+ message) でも scroll パフォーマンスが落ちない
- [ ] approval を deny した時に Codex が正しく abort して、UI が再開可能になる
- [ ] iPhone notification / Live Activity が「うっとうしい / 出てこない / 古い」の何れに
  もならない
- [ ] Mac Host を **launchd agent 化** (古い `dev.codex-link.mac-host` plist を p2p 版に
  置き換える). `pnpm --filter @codex-link/host start` を手動で叩く運用から脱却
- [ ] README.md にエンドユーザ向けの「インストールから初回接続まで」手順を書く

### 含まないもの
- AppleStore 提出
- Windows Host
- 多人数 (1 user = 複数 Mac Host) 対応
- Codex の高度なオプション (sub-agents, channels, advisor model 等)

### 検証 / Done 基準
1. 連続 7 日、kite が iPhone から Codex を本業務に使い、毎日 1 つ以上の thread を完走できる
2. クラッシュレポート 0 件
3. `Mac Host を再起動しないと直らない症状` が 0 件

---

## MVP 完了条件 (== Phase 14 終了)

ここまで来たら **MVP 完成**. CLAUDE.md / mvp-plan.md もこの定義に書き換える.

```
□ iPhone から prompt 投げて assistant 応答が見える
□ Approval (command/patch/file_write/network 4 種) が iPhone で操作できる
□ snapshot で起動直後 / 再接続後に transcript が復元される
□ Threads sheet / Settings sheet / ConversationFeed / ApprovalBanner / Composer がある
□ Live Activity が Dynamic Island + Lock screen に出る (iOS 17+)
□ launchd で Mac Host が自動起動する
□ 連続 7 日 dogfood で kite が「業務に使えた」と言える
```

---

## MVP 後 (= MVP 後 phase. roadmap.md の対象外、別文書)

- Phase 15: **Windows Host** (`apps/win-host/`). node-datachannel が Windows arm64 を将来
  サポートしたら追加 (2026-05 時点で x64 のみ)
- Phase 16: **AppleStore 配布**
  - Bundle ID 本番化 (`com.kitepon.codexlink` 等)
  - 配布証明書 + provisioning profile
  - プライバシー方針 + データ取扱記載
  - Live Activity の AppStore 審査互換性 (ContentState の制約等)
  - スクリーンショット、App Preview 動画
- Phase 17: 永続化 / 信頼性 (MVP 後 = nice to have)
  - Relay state の永続化 (現状はメモリのみ)
  - Device credential / TURN credential のローテーション
- Phase 18: 多人数 / multi-host
  - 1 user が複数 Mac (会社用 / 自宅用) を pair して、iPhone から切替

---

## ドキュメント更新 (この roadmap を採用した際の付随作業)

この roadmap を merge する PR で以下も同時に更新:

- [ ] **CLAUDE.md** の「してはいけないこと」セクションの
  `E2E privacy / 完全な thread / session 互換 / 中央 Codex 実行 を追加しない. MVP 非目標`
  を書き換え.  **完全な thread / session 互換は MVP 必須**. 残る MVP 非目標は
  「中央 Codex 実行 (Relay が Codex を直接 spawn する形)」と「E2E privacy (TURN を超えて
  Relay にもメッセージ秘匿)」だけ
- [ ] **docs/mvp-plan.md** の「MVP 後 (本リポジトリの将来)」セクションを書き直し
  - `Codex thread / session 完全互換` を削除 (MVP に組み込まれた)
  - 残るのは Windows Host / AppleStore / Relay 永続化 / credential rotation の 4 項目のみ
- [ ] **BOOTSTRAP.md** の冒頭 "新セッションが pick up する時の起点" に
  `Phase 1〜9 完走済. Phase 10〜14 は docs/roadmap.md` と明記

---

## 質問と判断

新セッションが詰まった時に kite に確認すべき項目:

- **Approval decision** を 2-way (approved boolean) のままにするか 4-way (accept/
  accept_for_session/decline/cancel) に拡張するか. 親リポ完全再現を優先するなら 4-way
- **Mac Host を launchd 化する時の Bundle ID / plist 名**. 旧 broker 版 plist
  (`dev.codex-link.mac-host`) を replace するか、別 ID で並列に置くか
- **Live Activity の iOS 16 対応**: 完全に切り捨てて OK か (kite の iPhone 16 Pro Max は
  iOS 26.5 なので問題なし、配布対象を iOS 17+ に限定する判断で済む)
- Codex の **どの distribution channel** に対応するか (codex CLI 直接 / Codex Desktop /
  別 binary). MVP では `which codex` で見つかった最初の 1 つに繋ぐで OK?
