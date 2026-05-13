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

初回起動で onboarding 画面が出る. Mac Host 側で `codex-link-host init` を
走らせて出力された **userId / deviceId / sessionToken / hostId** をコピペし、
Relay URL を入れて `Connect`.

Simulator でローカル Relay (`http://127.0.0.1:3000`) を使う場合は scheme の
Environment Variable で `CODEX_LINK_RELAY_URL=http://127.0.0.1:3000` を設定
(`project.yml` で既定済み).

## 注意

- `Sources/CodexLinkIOS/PeerConnection.swift` は `stasel/WebRTC` の XCFramework
  (~30 MB) をリンクする. App bundle 肥大は AppStore 提出時に評価.
- 現状の onboarding は **dev-only な手貼り付け方式**. 正規の QR pairing flow は
  MVP 後. 詳細は [BOOTSTRAP.md](../../BOOTSTRAP.md) Phase 4 と
  [docs/architecture.md](../../docs/architecture.md) 参照.
- Bundle ID は `dev.codexlink.ios`, Team ID は `TPWX489GV4` (kite 個人).
  AppStore 提出時に本番 ID / 配布証明書へ切替.

## 関連

- [../../CLAUDE.md](../../CLAUDE.md) — リポジトリ全体の鉄則
- [../../BOOTSTRAP.md](../../BOOTSTRAP.md) — Phase 計画
- [../../docs/deploy.md](../../docs/deploy.md) — 本番 Relay デプロイ
