// WS wire messages は protocol package (rendezvous) に移動した. 後方互換の
// ため、ここから re-export する.
//
// 直接 `@codex-link/protocol/rendezvous` から import するのが推奨.

export type {
  InboundHostAnnounce,
  InboundPairingCodeCreate,
  InboundSignalToClient,
  InboundSignalToHost,
  InboundTurnCredentialRequest,
  OutboundError,
  OutboundPairingCodeIssued,
  OutboundSignalFromClient,
  OutboundSignalFromHost,
  OutboundTurnCredentialIssued,
  OutboundWelcome,
  WsInbound,
  WsOutbound,
} from "@codex-link/protocol/rendezvous";
