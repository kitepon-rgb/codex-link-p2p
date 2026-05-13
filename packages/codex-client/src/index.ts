// Codex `app-server` JSON-RPC client。
//
// Mac/Win Host が Codex app-server に話すための binding。
// - loopback WebSocket transport (`codex app-server --listen ws://127.0.0.1:0`)
// - stdio transport (codex spawn)
// - VS Code IPC follower (`$TMPDIR/codex-ipc/ipc-$UID.sock`)
//
// この module は Host 内部だけで使う。Relay / iPhone は import しない。

export {};
