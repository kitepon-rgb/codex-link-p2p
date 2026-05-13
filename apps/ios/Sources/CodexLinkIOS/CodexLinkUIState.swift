// UI に露出する観測可能 state.
//
// AppLifecycle / SessionProjection / PeerConnection から導出した「表示用」
// プロパティだけを露出する.

import Foundation
import SwiftUI

@MainActor
public final class CodexLinkUIState: ObservableObject {

    @Published public var connectionPhase: AppLifecycle.Phase = .idle
    @Published public var connectionPath: PeerConnectionPath = .connecting
    @Published public var currentHostId: HostId?
    @Published public var pairingCode: String?
    @Published public var pairingCodeExpiresAt: Int?

    public init() {}

    public func apply(phase: AppLifecycle.Phase) {
        connectionPhase = phase
    }

    public func apply(path: PeerConnectionPath) {
        connectionPath = path
    }

    // ユーザーから見て「いま速いか / 遅いか / 繋がってるか」だけ分かれば良い.
    // ICE candidate type の細かい区別 (host / srflx / relay) は実装の都合で、
    // 非エンジニアには「直結 / 中継」「速い / 遅い」の 2 軸だけ提示する.
    public func badgeText(for path: PeerConnectionPath) -> String {
        switch path {
        case .connecting: return "接続中…"
        case .direct: return "直結"
        case .stunReflexive: return "直結 (NAT越え)"
        case .turnRelayed: return "中継"
        case .failed: return "切断"
        }
    }

    public func badgeColor(for path: PeerConnectionPath) -> Color {
        switch path {
        case .connecting: return .gray
        case .direct: return .green
        case .stunReflexive: return .green     // ユーザー視点では direct と同等の速さ
        case .turnRelayed: return .yellow
        case .failed: return .red
        }
    }
}
