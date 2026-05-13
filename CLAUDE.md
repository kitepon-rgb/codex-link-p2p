# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリの位置づけ

`codex-link-p2p` は、隣の `/Users/kite/Developer/codex-link` の **アーキ是正版** として新規に作るプロジェクト。

`codex-link` は過去の Claude セッションが **broker 型** で実装してしまい、Relay が iPhone⇄Mac の全 payload を経由する形になっている。これはユーザー (kite) の当初設計意図 (Relay = 認証付き接続案内人、データは P2P 直接) と乖離している。

`codex-link` は「これはこれで動くので保全する」決定が出ている。本リポジトリ `codex-link-p2p` は **day 1 から rendezvous + WebRTC P2P** で作り直す。

最終目標: AppleStore 配布される iPhone app と、`npm install -g` 一発で動く Mac/Windows Host を提供。Relay (= `kitepon.dynv6.net`) はマルチテナント認証 + signaling + TURN credential 発行のみ。

## 守るべきアーキテクチャ鉄則 (絶対)

- **Relay は payload を観測しない**。`client.toHost` / `host.event` のような payload routing を絶対に作らない。
- Relay の責務: 認証 / device session / Host registry / online state / HostAccess / **WebRTC signaling envelope の中継** / **ephemeral TURN credential の発行** / audit metadata / rate limit。それ以外はやらない。
- データ平面 (`CodexLinkEvent`、command、approval、snapshot) は **WebRTC DataChannel で iPhone⇄Mac Host 直接**。Relay を絶対に通さない。
- WebRTC: STUN は Google public (`stun:stun.l.google.com:19302`)。TURN は kite サーバーに同居デプロイされた coturn。TURN credential は Relay が ephemeral に発行 (HMAC-SHA1 で coturn `use-auth-secret` 互換)。
- DTLS-SRTP の E2E 暗号化により Relay と TURN は payload を **復号できない**。これがユーザーの「サーバーは接続案内人」設計の物理的保証。
- `packages/protocol` は **rendezvous.ts (Relay が見て良い型) と session.ts (DataChannel 上だけ流れる型) を物理的に分離**。`services/relay` から `@codex-link/protocol/session` を import 禁止 (lint rule 必須)。
- Host は inbound port を持たない。Relay へ outbound WSS、iPhone へは offerer/answerer の ICE 候補交換で繋ぐ。
- iPhone app は raw Codex app-server JSON-RPC を直接話さない。`packages/protocol/session` のみ。
- iPhone は SSH client ではなく、project folder を直接読まない。
- Relay はグローバル Host 一覧を返さない。すべての routing / listing で現在の user の `HostAccess` を確認する。
- Relay は単一の共有 API token を使わない。credential は device ごとで取り消し可能、Relay は token 本体ではなく SHA-256 hash だけを保存する。
- 共有 / 本番環境の Relay は Docker コンテナでデプロイする。サーバーへ Node.js アプリを直置きしない。
- 永続的なコード状態は GitHub を通す (branch / commit / PR / issue / docs)。別の永続化チャネルを追加しない。
- 「`codex-link` (broker 版)」を **参照として読み出す** ことはあるが、コードをそのまま import / リンクしない。再利用したいファイルは新リポジトリにコピーして broker 依存箇所を除去する。

## してはいけないこと

- broker、event cache、`client.toHost`、`host.event`、`subscribeHost` 系の概念を 1 行たりとも書かない。
- 「とりあえず動かすために Relay を中継させる」を絶対にやらない。NAT 越え失敗時の fallback も TURN credential 経由 (coturn) のみ。
- AppleStore 公開対応の延期を理由に Relay 経由データに後退しない。
- E2E privacy / 完全な thread / session 互換 / 中央 Codex 実行 を追加しない。MVP 非目標。
- placeholder device session の上に production-grade auth を勝手に積まない。
- doc 上だけで存在しない build / test command を書かない。

## 開発コマンド

TypeScript workspace は `pnpm` を使う (`pnpm-workspace.yaml`)。

```bash
pnpm install
pnpm typecheck                # 全 workspace package で tsc --noEmit
pnpm test                     # 全 workspace package で vitest run
pnpm build                    # build (実 emit は relay のみ、他は tsc --noEmit)
```

package ごと:

```bash
pnpm --filter @codex-link/relay test
pnpm --filter @codex-link/relay typecheck
pnpm --filter @codex-link/mac-host start -- ~/.codex-link-p2p/host.json
```

ローカル Relay + coturn (Docker Compose):

```bash
docker compose up --build relay coturn
```

iOS:

```bash
cd apps/ios
swift test
```

## このリポジトリの TS 規約

- 全体 ESM (`"type": "module"`)。TS の相対 import は `.js` 拡張子必須 (NodeNext): `import { foo } from "./bar.js"`。
- TS は strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax` 有効。型のみ import は `import type` を使い、optional property は本当に optional として宣言する (`T | undefined` ではなく `T?`)。
- branded ID: `UserId` / `DeviceId` / `HostId` は `string & { readonly __brand: ... }`。helper 経由で発行し、生 string を cast しない。

## 関連ドキュメント

- [BOOTSTRAP.md](BOOTSTRAP.md): 新セッションが pick up する時の起点。Phase 1-9 の実装計画。
- [docs/architecture.md](docs/architecture.md): topology、signaling sequence、データ平面。
- [docs/security-model.md](docs/security-model.md): DTLS-SRTP E2E、Relay の payload-blind 性。
- [docs/requirements.md](docs/requirements.md): 機能 / 非機能要件。
- [docs/mvp-plan.md](docs/mvp-plan.md): MVP の Phase 計画。

## 参照リポジトリ (読み出しのみ)

`/Users/kite/Developer/codex-link/` を broker 版の参照実装として読むことができる。再利用候補:

- Codex event 正規化 (`apps/mac-host/src/codex-events.ts`)
- Host config / capabilities (`apps/mac-host/src/{config,capabilities}.ts`)
- SessionProjection (`apps/ios/Sources/CodexLinkIOS/SessionProjection.swift`)
- Live Activity (`apps/ios/Sources/CodexLinkIOS/LiveActivity.swift`)
- iOS UI (`apps/ios/Sources/CodexLinkIOS/CodexLinkRootView.swift`、`CodexLinkPreviewCanvas.swift`)
- Relay の auth / device session / Host registry / pairing 部分 (`services/relay/src/{relay,state,config}.ts` のうち broker 依存していない関数)
- Codex `app-server` smoke script (`scripts/codex-app-server-smoke.mjs`)

再利用する時は本リポジトリにコピーして、broker 依存 (`appendHostEvent`、`client.toHost`、`host.event`、event cache 関連) を完全に除去すること。
