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

export * from "./config.js";
export * from "./state.js";
export * from "./ids.js";
export * from "./relay.js";
export * from "./turn.js";
export * from "./signaling.js";
export * from "./http.js";
export * from "./ws-messages.js";
export * from "./websocket.js";
export {
  createRelayServer,
  startRelayServer,
  type StartedServer,
  type CreateRelayServerInput,
  type CreatedRelayServer,
} from "./server.js";
