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

    public func badgeText(for path: PeerConnectionPath) -> String {
        switch path {
        case .connecting: return "Connecting…"
        case .direct: return "Direct"
        case .stunReflexive: return "STUN"
        case .turnRelayed: return "TURN"
        case .failed: return "Failed"
        }
    }

    public func badgeColor(for path: PeerConnectionPath) -> Color {
        switch path {
        case .connecting: return .gray
        case .direct: return .green
        case .stunReflexive: return .blue
        case .turnRelayed: return .yellow
        case .failed: return .red
        }
    }
}
