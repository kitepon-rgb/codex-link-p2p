# POSTMORTEM: codex-link-p2p

> **Status: Archived (2026-05-15)**
> 開発を終了する。OpenAI が 2026-05-14 に **ChatGPT mobile app に Codex remote
> control** を発表したことで、本プロジェクトが提供するはずだった価値 (iPhone
> から Mac 上の Codex を操作する) が公式機能で代替可能になった。

このドキュメントは **学びの記録** として残す。コードは reference 用に GitHub
([kitepon-rgb/codex-link-p2p](https://github.com/kitepon-rgb/codex-link-p2p))
に置いたまま。CI / 配布 / dogfood は停止する。

---

## 1. 終了の引き金 (2026-05-14)

OpenAI 発表内容 ([9to5Mac](https://9to5mac.com/2026/05/14/openai-brings-codex-control-to-chatgpt-for-iphone-and-android/) /
[TechCrunch](https://techcrunch.com/2026/05/14/openai-says-codex-is-coming-to-your-phone/) /
[OpenAI Devs on X](https://x.com/OpenAIDevs/status/1924601527898951914)):

| 機能 | OpenAI 公式 (ChatGPT mobile) | codex-link-p2p (本プロジェクト) |
|---|---|---|
| iPhone から Mac 上の Codex を操作 | ✅ | ✅ (dogfood 未完) |
| QR pairing | ✅ | ✅ |
| Approval (command 実行承認) | ✅ | ✅ (4-way) |
| Diff / terminal output / screenshot stream | ✅ | ✅ (transcript / timeline) |
| Push PR from phone | ✅ | ❌ |
| Live Activity (lock screen) | ✅ | ✅ (Phase 13) |
| 配布形態 | ChatGPT iOS app に内包 (App Store 既配布済) | TestFlight すら未着手 |
| 課金 | 全プラン (Free 含む) | self-host (=実質 free) |
| 実機 7 日 dogfood 検証 | OpenAI 内部で完了済 (preview 一般公開) | **0 日 / 7 日** |
| Windows host | "follow soon" 公式言明 | apps/win-host/ 空殻 |

**ユーザの判断 (2026-05-15)**: 「やりたいことが全部できる。本プロジェクトに優位性
はないと考える。」

正しい判断。ChatGPT app に内包 = AppStore 配布の苦労ゼロ + 全 user に即時配布
= self-host (Relay + coturn 自前運用 + bootstrap token 配布) より圧倒的にラク。

---

## 2. プロジェクトの位置づけ (なぜ作っていたか)

`codex-link-p2p` は隣のリポジトリ
[`/Users/kite/Developer/codex-link/`](https://github.com/kitepon-rgb/codex-link)
の **アーキ是正版** として 2026-05-13 に bootstrap した。

`codex-link` は過去の Claude セッションが **broker 型** で実装してしまい、Relay
が iPhone⇄Mac の全 payload を経由する形になっていた。これはユーザ (kite) の
当初設計意図 (Relay = 認証付き接続案内人、データは P2P 直接) と乖離していた。

`codex-link-p2p` は day 1 から:
- WebRTC DataChannel で iPhone⇄Mac Host **直接通信**
- Relay は signaling envelope の中継 + ephemeral TURN credential 発行のみ
- DTLS-SRTP の E2E 暗号化で Relay も TURN も payload を **復号できない**

という設計で組み直した。これは技術的に正しく、Phase 1〜14b で実装も完走した。
**正しいものを作っていたが、market timing で負けた**。

---

## 3. 何が動くようになったか (= 残す資産)

| Phase | 内容 | 検証状況 |
|---|---|---|
| 1 | Protocol 分割 (rendezvous / session) + ESLint guard | ✅ 105 tests |
| 2 | Relay (HTTP + WS signaling + TURN cred) | ✅ payload-blind 確認済 |
| 3 | Mac Host (config / token-store / signaling-client / peer / codex skeleton) | ✅ 63 tests + E2E |
| 4 | iOS (Swift mirror / SignalingWS / PeerConnection / SessionProjection / SwiftUI) | ✅ 24 swift tests |
| 5 | coturn 同居 (compose + use-auth-secret) | ✅ verify script |
| 6 | E2E (in-process Relay + Mac Host + raw iPhone offerer) | ✅ |
| 7 | Connection path (direct/srflx/prflx/relay バッジ) | ✅ |
| 8 | docs 整合 + ESLint guard | ✅ |
| 9 | npm 一発配布 (`@codex-link/host`) + `pair` CLI | ✅ |
| 10 | Mac Host から Codex に実 wire (`codex app-server` spawn + WS JSON-RPC) | ✅ unit |
| 11 | Session protocol を broker 版完全互換に (4-way approval / TimelineEntry / TranscriptItem) | ✅ |
| 12 | iPhone UI 親リポ同等 (Threads / Settings / Auto-scroll / Timeline / 4-way approval) | ✅ |
| 13 | Live Activity (Widget extension + Dynamic Island + Lock screen) | ✅ build |
| 14a | Mac Host launchd agent 化 + install script | ✅ |
| 14b | Resilient Codex client (指数バックオフ respawn) + Live Activity 500ms debounce + transcript 500 件 cap + dogfood-sim 5 件 | ✅ vitest |
| 14c | **実機 7 日 dogfood** | ❌ 0 日 / 7 日 |

最終状態: **189 TS test + 25 Swift test green、Mac Host build 成功、iOS App build
成功、kite Mac で Mac Host 起動 + iPhone QR pairing + DC open + Pairing 後の
Send button 押下まで通った**。だが Send 後に Codex 応答が iPhone に戻ってこ
ない症状を捕まえた直後に OpenAI 発表で終了。

---

## 4. dogfood で見つかった生バグ (= 直してれば本物の MVP だった)

`42fabf0` で commit した unfinished 修正に紐づく:

### 4.1 dispatchUIAction が壊れていた (= Phase 11 の取りこぼし)

`SessionManager.dispatchUIAction("ui.submit_turn")` が以下のように書かれていた:

```ts
await this.options.codex.startTurn({
  threadId: action.threadId as string,
  prompt: action.input,
});
```

しかし実 Codex `app-server` の `turn/start` API は:
- `prompt: string` ではなく `input: [{ type: "text", text, text_elements: [] }]`
- 事前に `thread/start` を呼んで返ってくる `thread.id` を使う

の 2 段階呼び出しが必要だった。**broker 版 (codex-link) は正しく実装されてい
たが、Phase 10 で port した時にこの細部がドロップしていた**。

修正 (`42fabf0`): broker 版と同形に書き直し。`thread/start` → `turn/start` の
2 段階、`startTurn` は input 配列形式、cwd / serviceName / approvalsReviewer
/ experimentalRawEvents を必須引数として渡す。

### 4.2 Empty thread state で composer が出ない

`CodexLinkRootView.placeholder` が "Waiting for Host…" だけで、threads が
0 件の状態から **新規 thread を作る経路が UI に存在しなかった**。Mac Host が
project list を populate しないと placeholder のまま。

修正 (`42fabf0`):
- Mac Host: SessionManager constructor で defaultProjectId をもつ Default
  project を populate
- iOS: thread 0 件時の placeholder を TextField + Send composer に差し替え

### 4.3 ICE candidate race condition (再 pair 直後)

Mac Host を再起動してから iPhone を再 pair すると、iPhone から飛んでくる
ICE candidate が:

```
addRemoteCandidate_failed: "Got a remote candidate without ICE transport"
```

で 50+ 連続失敗する。**offer の `setRemoteDescription` の async 初期化が
完了する前に candidate が到着している race**。

未修正。直すなら Mac Host 側で setRemoteDescription 完了まで candidate
を queue に貯める実装が要る。

### 4.4 frame 経路の sliencing

iPhone の `submitTurn` は発火、DC `send (144 bytes)` も成功、しかし Mac Host
側で `peer_frame_received` が出ないケースがあった。peer state が `.failed →
connecting` に推移する瞬間に DC で送出される event が落ちている疑い。

未修正。これも `42fabf0` で診断ログを足したところで止まった。

---

## 5. 学び (=他プロジェクトに転用できる)

### 5.1 アーキテクチャ

- **Relay payload-blind の物理的保証 (DTLS-SRTP E2E)** は技術的に成立する。
  `services/relay/src` を `eslint-no-restricted-imports` で
  `@codex-link/protocol/session` から物理的に切り離す guard が効果的だった。
  「人間が忘れない」ではなく「import すると build error」で守る。
- **`packages/protocol` を rendezvous.ts と session.ts で物理分離** したのは
  正解。Relay が誤って payload-aware な型を import しようとするとビルドが
  通らない。
- **branded ID** (`UserId & {__brand}`) で生 string cast を全禁止 → 「device
  ID と user ID を取り違える」種類のバグが発生しなかった。

### 5.2 WebRTC + iOS

- `connectionPath` (UI 上の direct/srflx/prflx/relay バッジ) を **唯一のソース
  にする** = peer state machine の中で `prflx` を NAT 越え扱いする 1 行で
  「ずっと接続中…」フリーズが消えた (commit `80604ef`)。
- `RTCPeerConnection.statistics(...)` を 5s 周期で取って path を再計算する
  だけで、iOS 側に WebRTC stack の中まで突っ込まずに済む。
- Live Activity は `ActivityKit` + `WidgetKit` の Widget extension target
  が **必須** (主 app target に書いても表示されない)。XcodeGen で `type:
  app-extension` の独立 target を切る必要あり。
- iOS 17 未満を完全に切り捨てる判断 (`#available(iOS 17.0, *)`) は
  Live Activity を成立させる前提条件。後方互換を捨てる勇気。

### 5.3 認証 / 配布

- **device session token は Relay 側で SHA-256 hash だけ保存** (生 token は
  Keychain / host.json のみ)、device ごとに revoke 可能、bootstrap token
  だけが「Relay の合言葉」 — このシンプルなモデルでマルチテナントが回る。
- ただし **Relay state の永続化を最後まで先送りした** (Phase 17) ため、
  Relay コンテナ再起動で全 device session が wipe され、bootstrap から
  やり直しが必要だった。dogfood 中に実害が出た (commit log に痕跡)。
- Apple 配布の壁 (Bundle ID / 配布証明書 / プライバシー方針 / Live Activity
  審査互換性) を MVP 後に回したのが結果的に致命傷。**この壁を超える前に
  公式が出てきた**。

### 5.4 Claude セッション運用

- **Stop hook で「Phase 14c まで進めろ」と無限ループ** させても、Phase 14c
  は構造的に user 手番 (連続 7 日業務利用) なので Assistant では満たせない。
  「assistant が物理的に達成不可能な完了条件」を hook に積むと無駄に費用が
  かかる。今回 15+ 回ループした。
- 実機 dogfood の debug は **JSON 構造化ログ (`level: info, msg: peer_frame_received`)
  を経路の各段に仕込む** のが最速だった。「どこで止まったか」が即わかる。

### 5.5 OpenAI / Anthropic の遅延コスト

- Anthropic は 2026-02 に Claude Code Remote Control を出した。OpenAI は 3
  ヶ月遅れの 2026-05 で同等機能を出した。**個人開発者の self-host 同等品は
  両社とも 3 ヶ月以内に完成形を出してくる** と見るべきだった。
- 隣の `codex-link` (broker 版) を 2026-04 に作り、`codex-link-p2p` を
  2026-05-13 にやり直した時点で、**OpenAI 公式が同月発表する可能性を引いて
  いない** = 個人開発者にとっては「2 週間先行して完成させて TestFlight に
  上げる」スピードが要求された。今回はそこに届かなかった。

---

## 6. 残された artifact

### コード
- このリポジトリ (`main` branch) — そのまま残す
- 隣の `codex-link` (broker 版、kitepon-rgb/codex-link) — そのまま残す
  - broker 版は Relay payload-routing を含むので security model 上 deploy
    しないが、コードは reference として有用

### 配布
- `@codex-link/host` の npm publish はしていない (publish 直前で停止)
- App Store / TestFlight 提出はしていない
- self-host していた Relay (`kitepon.dev` / Docker Compose) は停止予定

### ドキュメント
- 本ファイル (POSTMORTEM.md) ← 学びの集約
- CLAUDE.md / BOOTSTRAP.md / docs/roadmap.md / docs/mvp-plan.md /
  CHANGELOG.md — 各冒頭に **Archived 注記** を入れて当時の文脈は保全
- docs/architecture.md / docs/security-model.md / docs/requirements.md /
  docs/deploy.md / docs/dogfood-runbook.md — そのまま (技術 reference 価値あり)

---

## 7. 公式版を使う上での切替手順 (kite 個人メモ)

OpenAI 公式 ChatGPT mobile + Codex for Mac で同等のことをやる:

1. App Store で ChatGPT iOS app を最新版に
2. Mac で Codex for Mac (= `Codex.app` already installed at `/Applications/Codex.app`)
   を最新版に
3. ChatGPT iOS app 内で「Codex」セクションを開く → QR を表示 → Mac の
   Codex for Mac でスキャン (公式は Mac 側で QR 表示 / iPhone でスキャン
   の方向性。本プロジェクトと逆だが慣れの問題)
4. 同じ ChatGPT account にログインしている前提
5. Live Activity / Approval / diff stream は公式実装に任せる

self-host が要らなくなった = bootstrap token / Relay 運用 / coturn 運用 /
Apple 配布証明書 全部が不要に。**この simplification こそが市場優位**。

---

## 8. クロージング

技術的には正しいものを作った。設計鉄則 (Relay payload-blind / E2E DTLS-SRTP /
protocol 物理分離 / branded ID / `client.toHost` 禁止) は最後まで守られた。
189 + 25 = **214 件のテストが green の状態で archive**。

**Market が公式実装に流れた時点で、self-host 個人開発の出口は無い**。
撤退判断 (2026-05-15) は正しい。

このリポジトリは **「正しい P2P signaling アーキを WebRTC + Swift + Node で
実装した参考事例」** として残す。次に同種のものを作る時は本ファイル + 隣の
`codex-link` (broker 版との比較) を読み返す。

— kite + Claude (2026-05-15)
