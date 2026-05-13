// CodexLinkIOS — iPhone app core module.
//
// 責務 (CLAUDE.md より):
// - User / Device として認証する
// - HostAccess の中から Host を選択する
// - WebRTC peer (iPhone は offerer 固定) を Mac/Win Host との間で構築する
// - DataChannel `codex-link-session` で CodexLinkEvent を受信、command を送信
// - SessionProjection で transcript / timeline / approval を表示
// - replay-on-peer: peer 確立後に SessionSnapshotRequest を送る
// - 接続経路 (direct / srflx / relay) を可視化する
//
// 主要 file (Phase 1-7 で実装):
// - SignalingWebSocketClient.swift (Relay との signaling 専用 WS)
// - PeerConnection.swift (RTCPeerConnection、DataChannel、ICE)
// - SessionProjection.swift (../codex-link から再利用)
// - RelayMessages.swift (signaling メッセージ型のみ)
// - SessionStartup.swift / SessionRestore.swift (replay-on-peer)
// - AppLifecycle.swift (起動 / 復元 / 再接続オーケストレーション)
// - CodexLinkRootView.swift / CodexLinkUIState.swift (UI)
// - LiveActivity.swift

public enum CodexLinkIOS {
    public static let version = "0.0.0"
}
