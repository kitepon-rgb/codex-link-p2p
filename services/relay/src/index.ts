// Relay entry point.
//
// 責務 (CLAUDE.md より):
// - 認証 / device session / Host registry / online state / HostAccess
// - WebRTC signaling envelope の中継
// - ephemeral TURN credential の発行
// - audit metadata、rate limit、payload size limit
//
// 絶対に作らない:
// - client.toHost / host.event / host.subscription.ready
// - event cache
// - payload routing
//
// import 制約: `@codex-link/protocol/session` をここから import してはいけない。
// signaling envelope は base64 のまま forward する。

export {};
