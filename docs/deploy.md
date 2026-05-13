# Production Deploy

`codex-link-p2p` を kite サーバー (`kitepon.dynv6.net`) に同居デプロイする手順.

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
                              ─── TURN ───► codex-link-p2p.kitepon.dynv6.net:3478
                              ─── TURNS ──► codex-link-p2p.kitepon.dynv6.net:5349
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

[kitepon.dynv6.net](https://dynv6.com/) の管理画面で 1 つの A レコードを追加.
HTTPS (443) と TURN (3478/5349) は同じホスト名で別ポート同居.

| Hostname                                | Type | Target          |
|-----------------------------------------|------|-----------------|
| `codex-link-p2p.kitepon.dynv6.net`      | A    | サーバー IPv4   |

### 2. ファイアウォール / ポート

サーバーで開ける必要があるポート:

| Port      | Proto    | 目的                                    |
|-----------|----------|----------------------------------------|
| 80        | TCP      | Caddy ACME HTTP-01 challenge           |
| 443       | TCP      | Caddy: HTTPS + WSS → Relay             |
| 3478      | UDP+TCP  | coturn: STUN / TURN                    |
| 5349      | UDP+TCP  | coturn: TURNS (TLS)                    |
| 49152–65535 | UDP    | coturn: relay candidate range          |

`ufw` の場合:
```bash
sudo ufw allow 80/tcp 443/tcp 3478 5349
sudo ufw allow 49152:65535/udp
```

### 3. サーバー初回セットアップ

```bash
# Docker + compose
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER
newgrp docker

# リポジトリを clone
mkdir -p ~/codex-link-p2p && cd ~/codex-link-p2p
git clone https://github.com/kitepon-rgb/codex-link-p2p.git .

# 本番 .env を作成 (secrets を埋める)
cp .env.prod.example .env
$EDITOR .env
#   CODEX_LINK_HOST_BOOTSTRAP_TOKEN=`openssl rand -hex 32`
#   TURN_SHARED_SECRET=`openssl rand -hex 32`

# 初回起動
docker compose -f compose.yaml -f compose.prod.yaml up -d --build

# 数十秒待って疎通確認
curl -fsS https://codex-link-p2p.kitepon.dynv6.net/api/health
# => {"ok":true}
```

### 4. (Optional) GitHub から自動デプロイ

`main` へ push されたらサーバーで `git pull && docker compose up -d` が走る形.
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) が雛形.

サーバー側でデプロイ専用 SSH キーを作る:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/codex-link-deploy -N "" -C "github-actions deploy"
cat ~/.ssh/codex-link-deploy.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/codex-link-deploy        # 秘密鍵 (GitHub Secrets に貼る)
```

GitHub repo Settings → Secrets and variables → Actions に 4 つ追加:

| Name                       | Value                                |
|----------------------------|--------------------------------------|
| `CODEX_LINK_DEPLOY_HOST`   | サーバーホスト名 (例: kitepon.dynv6.net) |
| `CODEX_LINK_DEPLOY_USER`   | SSH ユーザー名                       |
| `CODEX_LINK_DEPLOY_KEY`    | `~/.ssh/codex-link-deploy` の中身全文 |
| `CODEX_LINK_DEPLOY_DIR`    | 例: `/home/kite/codex-link-p2p`      |

これ以降、`main` への push で workflow が走り、自動で `git pull + compose up + /api/health smoke` まで実行する.

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
  codex-link-p2p.kitepon.dynv6.net
```

## トラブルシュート

| 症状                                             | 確認                                                   |
|--------------------------------------------------|--------------------------------------------------------|
| `curl https://codex-link...` で TLS handshake 失敗 | Caddy ログ. ACME challenge が 80/tcp で完了したか      |
| iPhone から接続できないが Mac Host は OK         | iPhone 側の TURN credential 取得失敗. Relay の `issueTurnCredential` ログ |
| `relay/api/health` が timeout                    | container のヘルスチェック (`docker compose ps`) と Caddy のアップストリーム設定 |
| coturn が TLS で連携失敗                         | Caddy が `codex-link-p2p.kitepon.dynv6.net` の cert を発行したか. `caddy_data` volume 内に `.crt` / `.key` が出ているか |
| 接続経路バッジが常に `turn`                      | NAT が両側 symmetric. これは TURN 必須なので想定内    |

## 関連

- [architecture.md](architecture.md) — 全体トポロジ
- [security-model.md](security-model.md) — payload-blind の保証
- [requirements.md](requirements.md) — 機能 / 非機能要件
