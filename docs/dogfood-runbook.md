# Dogfood Runbook (Phase 14c)

Phase 14c の Done 基準:

> **連続 7 日、kite が iPhone から Codex を本業務に使い、毎日 1 つ以上の thread を完走できる**
> **クラッシュレポート 0 件**
> **Mac Host を再起動しないと直らない症状が 0 件**

これを 7 日間でクリアするための日次 checklist と、不具合発見時のレポートテンプレ.

---

## 初日 (Day 1) のセットアップ

```sh
# Mac で:
cd ~/Developer/codex-link-p2p
git pull origin main
pnpm install
pnpm --filter @codex-link/host build

# 旧 broker 版 plist が居れば事前に unload (再起動毎の WS 奪い合い回避).
launchctl list | grep -i codex-link
launchctl unload ~/Library/LaunchAgents/dev.codex-link.mac-host.plist 2>/dev/null || true
rm ~/Library/LaunchAgents/dev.codex-link.mac-host.plist 2>/dev/null || true

# p2p 版を launchd agent として install.
bash apps/mac-host/launchd/install-launchd.sh
launchctl list | grep dev.codex-link-p2p   # 起動確認
tail -f ~/Library/Logs/codex-link-p2p-mac-host.log   # ログ tail を別 tab で
```

iPhone 側:

1. 古い CodexLink app を削除 (long press → Delete).
2. Xcode を開く: `apps/ios/CodexLink.xcodeproj` (deployment target が iOS 17 に上がっているため iPhone 16 Pro Max + iOS 26.5 で OK).
3. iPhone を connect、Run (⌘R) で再インストール.
4. アプリ起動 → 「Scan QR」.
5. Mac で `node /Users/kite/Developer/codex-link-p2p/apps/mac-host/dist/cli.js pair` を実行 → QR を iPhone カメラで読む.
6. バッジが「接続中…」→「直結 (NAT越え)」or「直結」に推移すること.
7. Mac で 1 thread 投げて transcript が iPhone に出ること.

---

## 日次 checklist (Day 1 〜 Day 7、毎晩 5 分)

| 観点 | チェック | 不具合時の記録項目 |
|---|---|---|
| **A. 基本疎通** | iPhone を開いて「直結」「直結 (NAT越え)」or「中継」のいずれか. 「切断」「エラー」「接続中…」のまま 30 秒以上止まったら NG | バッジ表示、iPhone debug log (`xcrun devicectl device copy from ...Documents/codex-link-debug.log`), Mac Host log の同時刻 |
| **B. 完走 thread 数** | 当日中 prompt 投げて assistant 応答まで届いた thread 数を記録 (最低 1) | 0 だった日は完全な不具合報告対象 |
| **C. Approval 操作** | tool 実行 approval が出る prompt (`ls -la /tmp/` 等) を 1 回投げる. iPhone で Approve / Deny を操作 → Codex が応答 / abort する | 反応しない / 反応が遅い場合は時刻と操作 sequence を記録 |
| **D. 再接続** | iPhone を 5 分以上 background → foreground 復帰. バッジが緑色に戻ること. Wi-Fi 切替 (家 ↔ Tailscale ↔ Cellular) を試す | 復帰しない場合は復帰時刻 + 何分かかったか |
| **E. Live Activity** | 長 turn を投げて Dynamic Island に「Running」, approval 時に「Approve」が出ること. ロック画面 widget で確認 | 出ない / 古い情報のまま固まる場合 |
| **F. クラッシュ** | iPhone app クラッシュ 0 件、Mac Host プロセス再起動の必要性 0 件 | クラッシュログ (iPhone Settings → Privacy → Analytics) と Mac Host log を記録 |
| **G. Memory / battery** | 1 日終わりに iPhone Settings → Battery で CodexLink の消費が極端でないこと (15% 超なら警告) | スクショ |

---

## 不具合発見時のレポートテンプレ

不具合を踏んだら以下を集めて issue に投げる (or 私に直接):

```
## Symptom
(1 行で書く. 例: "iPhone が `接続中…` で固まり、5 分待っても緑色に切り替わらない")

## Context
- 日付 / 時刻 (JST): YYYY-MM-DD HH:MM
- どの operation の最中: e.g. "prompt 投げて assistant 応答待ち", "Wi-Fi から Cellular に切替直後"
- iPhone state: foreground / background / lockscreen
- Mac Host state: launchd 起動中? 手動起動中?
- ネットワーク: 自宅 Wi-Fi / Tailscale / Cellular

## iPhone debug log (Documents/codex-link-debug.log の該当時刻 ±30s)
\```
(devicectl で取り出して貼る)
\```

## Mac Host log (~/Library/Logs/codex-link-p2p-mac-host.log の該当時刻 ±30s)
\```
(該当行)
\```

## 期待挙動
(例: "Wi-Fi 切替後 5 秒以内に再接続して緑色になる")
```

---

## 「Done」判定

7 日分の日次 checklist で **A〜F が全部 OK** (G は許容範囲なら OK) かつ **クラッシュ 0 件** で Phase 14c 完了. roadmap.md と CLAUDE.md の MVP 状態を **「達成」** に書き換える.

途中で何か出たら commit 履歴を分けて修正 (`fix(host): ...` / `fix(ios): ...`) し、修正コミットが入った時点で counter を Day 1 にリセットせず継続する (= 連続 7 日は「7 日間業務として使い続ける」であって「無瑕の 7 日」ではない).

---

## 想定される失敗モード (pre-emptive に潰した分)

これらは今 push されている `b8e4483` までの commit で対処済. 万が一発火したら緊急 fix:

- **Codex app-server crash** → `ResilientCodexClient` が指数バックオフで自動再起動. `codex_respawned` ログを watch.
- **Live Activity 高頻度 update** → 500ms debounce で抑制.
- **長 session の memory 肥大** → transcript / timeline を 500 件で先頭から落とす.
- **iPhone reconnect** → `signaling_welcome` 再受信で peer 全消去 + 再 ICE.
- **Wi-Fi ↔ Cellular 切替** → iOS WebRTC が prflx 経由で復帰 (pathBadge は「直結 (NAT越え)」).
