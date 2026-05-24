# Production Deploy

`codex-link-p2p` を kite サーバー (`kitepon.dev`) に同居デプロイする手順.

## 構成

```
            iPhone ─── HTTPS+WSS ──┐
                                   ▼
                           ┌───────────────┐
            Mac Host ───── │     Caddy     │ :443 (Let's Encrypt 自動)
                           │  (reverse-px) │
                           └───────┬───────┘
                                   │ internal http://relay:3000
                                   ▼
                           ┌───────────────┐
                           │     Relay     │ signaling-only
                           │  (Node 20)    │ payload-blind
                           └───────────────┘

            iPhone / Mac Host ─── STUN ───► stun.l.google.com:19302  (Google public)
                              ─── TURN ───► codex-link-p2p.kitepon.dev:3478
                              ─── TURNS ──► codex-link-p2p.kitepon.dev:5349
                                              │
                                              ▼
                                       ┌─────────────┐
                                       │   coturn    │ host network mode
                                       │ (use-auth-  │ ports 3478/5349 + 49152-65535/udp
                                       │  secret)    │
                                       └─────────────┘
```

DTLS-SRTP により Relay / coturn のどちらも payload を **復号できない**.
コードベース上の保証は [security-model.md](security-model.md) と
[architecture.md](architecture.md) を参照.

## 事前準備 (1 回だけ)

### 1. DNS

[kitepon.dev](https://dynv6.com/) の管理画面で 1 つの A レコードを追加.
HTTPS (443) と TURN (3478/5349) は同じホスト名で別ポート同居.

| Hostname                                | Type | Target          |
|-----------------------------------------|------|-----------------|
| `codex-link-p2p.kitepon.dev`      | A    | サーバー IPv4   |

### 2. ファイアウォール / ポート

サーバー / ルーター双方で開ける必要があるポート:

| Port        | Proto    | 経路                                              | 目的                                    |
|-------------|----------|---------------------------------------------------|----------------------------------------|
| 22          | TCP      | router → 192.168.1.2 (GH Actions 経由 deploy 用)  | SSH inbound (auto-deploy)              |
| 80          | TCP      | router → 192.168.1.2 (既存 Caddy が使用)          | Caddy ACME HTTP-01 challenge           |
| 443         | TCP      | router → 192.168.1.2 (既存 Caddy)                 | HTTPS + WSS → Relay                    |
| 3478        | UDP+TCP  | router → 192.168.1.2                              | coturn: STUN / TURN                    |
| 5349        | UDP+TCP  | router → 192.168.1.2                              | coturn: TURNS (TLS)                    |
| 49152–65535 | UDP      | router → 192.168.1.2                              | coturn: relay candidate range          |

`ufw` の場合 (本リポジトリ ops 用):
```bash
sudo ufw allow 22/tcp 80/tcp 443/tcp 3478 5349
sudo ufw allow 49152:65535/udp
```

### 3. サーバー初回セットアップ

> このリポジトリで実際に運用している環境では、サーバ (`kitepon.dev` の
> 192.168.1.2) に **既に license-server compose project の Caddy** が稼働して
> いて 80/443 を占有しています. その場合は **既存 Caddy を再利用** する形が
> ベスト (本セクションは その前提で書いています). 単独サーバへ deploy する
> 場合は [services/caddy/Caddyfile](../services/caddy/Caddyfile) を参考に
> 独自 Caddy を立ててください.

```bash
# Docker + git (Ubuntu 26.04 LTS では既に入っていれば skip)
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER
newgrp docker

# リポジトリを clone
cd ~ && git clone https://github.com/kitepon-rgb/codex-link-p2p.git
cd codex-link-p2p

# 本番 .env を作成 (secrets は openssl で生成)
cat > .env <<EOF
CODEX_LINK_RELAY_URL=https://codex-link-p2p.kitepon.dev
CODEX_LINK_HOST_BOOTSTRAP_TOKEN=$(openssl rand -hex 32)
TURN_SHARED_SECRET=$(openssl rand -hex 32)
TURN_REALM=codex-link-p2p
TURN_URLS=stun:stun.l.google.com:19302,turn:codex-link-p2p.kitepon.dev:3478,turns:codex-link-p2p.kitepon.dev:5349
TURN_CREDENTIAL_TTL_SEC=300
EOF
chmod 600 .env

# 起動 (relay + coturn の 2 つだけ. Caddy は既存を再利用するので含めない)
docker compose -f compose.yaml -f compose.prod.yaml up -d --build relay coturn
```

### 4. 既存 Caddy の Caddyfile に vhost を追加

`/home/kite/license-server/Caddyfile` の末尾に下記 block を append し、reload:

```caddy
# BEGIN codex-link-p2p managed route
codex-link-p2p.kitepon.dev {
	encode zstd gzip
	@ws {
		header Connection *Upgrade*
		header Upgrade websocket
	}
	reverse_proxy @ws 192.168.1.2:48080 {
		flush_interval -1
	}
	reverse_proxy 192.168.1.2:48080 {
		flush_interval -1
	}
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Frame-Options "SAMEORIGIN"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
		-X-Powered-By
		-Server
	}
}
# END codex-link-p2p managed route
```

```bash
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

数十秒で Let's Encrypt 自動発行が完了し、HTTPS が立ち上がる:

```bash
# 内部 (Caddy 経由なし、直接 relay)
curl -fsS http://192.168.1.2:48080/api/health     # => {"ok":true}
# 公開 URL (Caddy + ACME 経由)
curl -fsS https://codex-link-p2p.kitepon.dev/api/health   # => {"ok":true}
```

### 5. (Optional) GitHub から自動デプロイ

`main` へ push されたらサーバーで `git fetch + reset --hard + compose up` が走る形.
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) が雛形.

サーバー側でデプロイ専用 SSH キーを作る (秘密鍵はサーバから出さない):
```bash
ssh-keygen -t ed25519 -f ~/.ssh/codex-link-p2p-deploy -N "" -C "github-actions codex-link-p2p deploy"
cat ~/.ssh/codex-link-p2p-deploy.pub >> ~/.ssh/authorized_keys
```

dev 端末で `gh` CLI から Secret を 4 つ流し込む (秘密鍵は pipe で transcript に出さない):
```bash
ssh kite@192.168.1.2 'cat ~/.ssh/codex-link-p2p-deploy' \
  | gh secret set CODEX_LINK_DEPLOY_KEY --repo kitepon-rgb/codex-link-p2p
echo -n "kitepon.dev"          | gh secret set CODEX_LINK_DEPLOY_HOST --repo kitepon-rgb/codex-link-p2p
echo -n "kite"                       | gh secret set CODEX_LINK_DEPLOY_USER --repo kitepon-rgb/codex-link-p2p
echo -n "/home/kite/codex-link-p2p"  | gh secret set CODEX_LINK_DEPLOY_DIR  --repo kitepon-rgb/codex-link-p2p
```

設定済 Secret 一覧 (確認用):
```bash
gh secret list --repo kitepon-rgb/codex-link-p2p
```

これ以降、`main` への push で workflow が走り、`git fetch + reset --hard + compose up --build + caddy reload + 公開 URL smoke` まで自動実行される.

### 6. hairpin NAT について (LAN 開発時)

`kitepon.dev` の自宅 router が hairpin NAT (LAN→WAN→LAN ループバック) を
サポートしていない場合、**LAN 内**から `https://codex-link-p2p.kitepon.dev`
にアクセスすると timeout する. 開発端末の `/etc/hosts` に下記を追加して回避:

```
192.168.1.2 codex-link-p2p.kitepon.dev
```

GH Actions runner や Cellular 経由の iPhone は WAN 経由で正常に届く (この問題は
LAN 内クライアント特有).

## 運用

### ログ
```bash
docker compose -f compose.yaml -f compose.prod.yaml logs -f relay
docker compose -f compose.yaml -f compose.prod.yaml logs -f caddy
docker compose -f compose.yaml -f compose.prod.yaml logs -f coturn
```

### 再起動
```bash
docker compose -f compose.yaml -f compose.prod.yaml restart relay
```

### secret ローテーション

`TURN_SHARED_SECRET` を更新すると **現行接続中の peer が全て切れる** (graceful rotation は MVP 後).
`.env` を編集後:
```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d --force-recreate relay coturn
```

### TURN 疎通確認
```bash
turnutils_uclient -v -y \
  -u "$(date -d '+5 min' +%s):smoke" \
  -w "$(echo -n "$(date -d '+5 min' +%s):smoke" | openssl dgst -sha1 -hmac "$TURN_SHARED_SECRET" -binary | base64)" \
  codex-link-p2p.kitepon.dev
```

## トラブルシュート

| 症状                                             | 確認                                                   |
|--------------------------------------------------|--------------------------------------------------------|
| `curl https://codex-link...` で TLS handshake 失敗 | Caddy ログ. ACME challenge が 80/tcp で完了したか      |
| iPhone から接続できないが Mac Host は OK         | iPhone 側の TURN credential 取得失敗. Relay の `issueTurnCredential` ログ |
| `relay/api/health` が timeout                    | container のヘルスチェック (`docker compose ps`) と Caddy のアップストリーム設定 |
| coturn が TLS で連携失敗                         | Caddy が `codex-link-p2p.kitepon.dev` の cert を発行したか. `caddy_data` volume 内に `.crt` / `.key` が出ているか |
| 接続経路バッジが常に `turn`                      | NAT が両側 symmetric. これは TURN 必須なので想定内    |

## 開発環境メモ

### iPhone 実機ビルド時の Simulator runtime

実機 iPhone を新しい iOS にアップデートすると、その iOS バージョンに対応した
**Simulator runtime** が Xcode に入っていない状態になり、`xcodebuild` が

```
error: iOS 26.5 is not installed. To use this SDK, install the iOS 26.5 Simulator runtime.
```

のようなエラーで失敗する. 実機ビルドであっても Xcode の build system は対応
runtime の存在を要求する.

対応 runtime を入れる:

```sh
# 利用可能な platform 一覧 (現在の Xcode に対応するもの)
xcodebuild -showsdks

# 不足している iOS runtime を取得 (~8.5 GB). 対話 UI が出ないので CI でも使える.
xcodebuild -downloadPlatform iOS
```

特定バージョンだけ欲しい時:

```sh
xcrun simctl runtime install <path-to-dmg>
# あるいは Xcode → Settings → Platforms から GUI で
```

iPhone 側を iOS アップデートする都度確認するのが安全.

## 関連

- [architecture.md](architecture.md) — 全体トポロジ
- [security-model.md](security-model.md) — payload-blind の保証
- [requirements.md](requirements.md) — 機能 / 非機能要件
