# apps/ios

Codex Link iPhone app (`dev.codexlink.ios`).

## 構成

- `Sources/CodexLinkIOS/` — SwiftPM library (rendezvous / session 型のミラー、
  SignalingWebSocketClient、PeerConnection、SessionProjection、SwiftUI views)
- `Tests/CodexLinkIOSTests/` — `swift test` で走るユニット / wire 互換テスト
- `App/` — SwiftUI App エントリ (`CodexLinkApp.swift` + `Info.plist`)
- `Resources/Assets.xcassets/` — AppIcon / AccentColor
- `project.yml` — [XcodeGen](https://github.com/yonaskolb/XcodeGen) project spec

`CodexLink.xcodeproj` は **生成物**. リポジトリには checked-in しない.

## Library のテストだけ走らせる

```bash
cd apps/ios
swift test
```

## Simulator / 実機で App を起動する

### 1 回だけ: XcodeGen 導入

```bash
brew install xcodegen
```

### 2. xcodeproj 生成

```bash
cd apps/ios
xcodegen generate    # → CodexLink.xcodeproj
open CodexLink.xcodeproj
```

### 3. Build & Run

Xcode で `CodexLinkApp` scheme を選んで Simulator / 実機にビルド.

実機 iPhone を iOS 新バージョンに上げた直後は対応の Simulator runtime を
落とす必要がある (Xcode の "iOS X.Y is not installed" 警告で build が refuse される):
```bash
xcodebuild -downloadPlatform iOS  # ~ 8 GB、5-15 分
```

初回起動で onboarding 画面が出る (dev-only). 接続情報を入れる方法は以下のどちらか:

**A. 手貼り付け (Mac と iPhone で Universal Clipboard が効くなら)**

Mac で:
```bash
scripts/pair-to-clipboard.sh    # Mac Host にペアリング込みで clipboard に JSON を入れる
```
iPhone Onboarding → **Paste from Clipboard (JSON)** → **Connect**.

**B. ファイル直 push (実機で Universal Clipboard が同期しない時、dev 端末から)**
```bash
scripts/pair-to-clipboard.sh        # clipboard を一旦経由するが本体は /tmp/codex-link-pair.json
xcrun devicectl device copy to \
  --device <iPhone UDID> \
  --domain-type appDataContainer --domain-identifier dev.codexlink.ios \
  --source /tmp/codex-link-pair.json \
  --destination Documents/codex-link-pair.json
xcrun devicectl device process launch --terminate-existing \
  --device <iPhone UDID> dev.codexlink.ios
```
アプリ起動時に `AutoConnect.fromBundledPairFile()` が `Documents/codex-link-pair.json` を
読んで自動 connect する. onboarding 画面が出ない.

Simulator なら `xcrun simctl launch` に `SIMCTL_CHILD_CODEX_LINK_*` env で渡せる
(`AutoConnect.fromEnvironment()` が読む). project.yml の scheme でも環境変数指定可能.

> どちらも MVP 後に **QR scanner pairing** に置き換える前提の dev-only 経路.
> 詳細は [BOOTSTRAP.md の TODO セクション](../../BOOTSTRAP.md#todo--既知の応急処置-phase-9-完走後に判明).

## 注意

- `Sources/CodexLinkIOS/PeerConnection.swift` は `stasel/WebRTC` の XCFramework
  (~30 MB) をリンクする. App bundle 肥大は AppStore 提出時に評価.
- Bundle ID は `dev.codexlink.ios`, Team ID は `TPWX489GV4` (kite 個人).
  AppStore 提出時に本番 ID / 配布証明書へ切替.
- 4 つのソースファイル (CodexLinkApp / AppLifecycle / PeerConnection /
  SignalingWebSocketClient) に `diag`/`fwDiag`/`pcDiag`/`sigClientLog` の
  **NSLog + `Documents/codex-link-debug.log` への file writer** を埋め込んである.
  実機 debug 用. 本番では `#if DEBUG` ガード or 削除. ([TODO](../../BOOTSTRAP.md#ios--診断ログの整理))

## 関連

- [../../CLAUDE.md](../../CLAUDE.md) — リポジトリ全体の鉄則
- [../../BOOTSTRAP.md](../../BOOTSTRAP.md) — Phase 計画
- [../../docs/deploy.md](../../docs/deploy.md) — 本番 Relay デプロイ
