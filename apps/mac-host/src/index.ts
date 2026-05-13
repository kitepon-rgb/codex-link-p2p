// Mac Host entry point.
//
// 責務 (CLAUDE.md より):
// - device / Host として認証する
// - Relay へ outbound WSS を張る (signaling channel)
// - ローカル Codex を spawn / attach する
// - iPhone との WebRTC peer (answerer 固定) を維持する
// - DataChannel `codex-link-session` で CodexLinkEvent を送信、command を受信
// - replay-on-peer: SessionSnapshotRequest に現状 projection を返す
// - ICE restart で再接続を試みる
//
// 起動順 (cli.ts に展開):
// 1. config 読み込み (host.json + Keychain reference)
// 2. signaling 接続 (Relay へ Bearer device token)
// 3. announce (Host online を Relay に通知、payload なし)
// 4. Codex app-server spawn (loopback WebSocket)
// 5. peer 待受 (iPhone からの offer を待つ)

export * from "./config.js";
export * from "./token-store.js";
export * from "./signaling-client.js";
export * from "./peer.js";
export * from "./codex.js";
export * from "./codex-events.js";
export * from "./session.js";
