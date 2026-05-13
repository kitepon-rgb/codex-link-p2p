// SwiftUI App entry for the iOS app target.
//
// この target は XcodeGen で生成する xcodeproj の App target で組み立てる
// (`xcodegen generate` → CodexLink.xcodeproj). 実体のロジックは SwiftPM
// library `CodexLinkIOS` 側にある.
//
// onboarding の正規 flow (QR pair → Relay device-session register →
// AppLifecycle 構築) は MVP 後. 当面は dev-only な「Mac Host が `init` で
// 表示した値を手で貼り付けて connect」UI を入れて、Simulator / 実機での
// 疎通検証ができる状態にしている.
//
// 自動疎通テスト用に、起動時に以下の環境変数が全部揃っていれば onboarding
// 画面を skip して即接続する:
//   CODEX_LINK_RELAY_URL
//   CODEX_LINK_SESSION_TOKEN
//   CODEX_LINK_USER_ID
//   CODEX_LINK_DEVICE_ID
//   CODEX_LINK_HOST_ID
// Xcode の scheme editor または `xcrun simctl launch` の `SIMCTL_CHILD_*=`
// プレフィックスで注入できる.

import SwiftUI
import UIKit
import CodexLinkIOS

/// 診断用: NSLog に出すと同時に Documents/codex-link-debug.log に追記.
/// devicectl device copy from で取り出して解析する.
func diag(_ message: String) {
    NSLog("[codex-link] %@", message)
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    if let path = docs?.appendingPathComponent("codex-link-debug.log") {
        let line = "\(Date().ISO8601Format()) \(message)\n"
        if let data = line.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: path.path) {
                if let h = try? FileHandle(forWritingTo: path) {
                    defer { try? h.close() }
                    _ = try? h.seekToEnd()
                    try? h.write(contentsOf: data)
                }
            } else {
                try? data.write(to: path)
            }
        }
    }
}

@main
struct CodexLinkApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @State private var lifecycle: AppLifecycle?
    @StateObject private var uiState = CodexLinkUIState()

    var body: some View {
        if let lifecycle {
            CodexLinkRootView(lifecycle: lifecycle, uiState: uiState)
        } else if let fileLifecycle = AutoConnect.fromBundledPairFile() {
            // Documents/codex-link-pair.json があれば onboarding を skip して
            // それを使って auto-connect する. devicectl copy で push される.
            CodexLinkRootView(lifecycle: fileLifecycle, uiState: uiState)
                .onAppear {
                    diag("ContentView onAppear: file-pair path")
                    self.lifecycle = fileLifecycle
                    fileLifecycle.start()
                    diag("fileLifecycle.start() returned")
                }
        } else if let envLifecycle = AutoConnect.fromEnvironment() {
            CodexLinkRootView(lifecycle: envLifecycle, uiState: uiState)
                .onAppear {
                    diag("ContentView onAppear: envLifecycle path")
                    self.lifecycle = envLifecycle
                    envLifecycle.start()
                    diag("envLifecycle.start() returned")
                }
        } else {
            OnboardingView { lc in
                diag("ContentView onConnect callback received lifecycle")
                self.lifecycle = lc
                lc.start()
                diag("lc.start() returned")
            }
        }
    }
}

private enum AutoConnect {
    /// Documents/codex-link-pair.json があればそれから AppLifecycle を作る.
    /// devicectl device copy to で push して使う.
    @MainActor
    static func fromBundledPairFile() -> AppLifecycle? {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        guard let path = docs?.appendingPathComponent("codex-link-pair.json"),
              FileManager.default.fileExists(atPath: path.path),
              let data = try? Data(contentsOf: path) else {
            return nil
        }
        struct Payload: Decodable {
            let relayUrl: String
            let sessionToken: String
            let userId: String
            let deviceId: String
            let hostId: String
        }
        guard let p = try? JSONDecoder().decode(Payload.self, from: data),
              let url = URL(string: p.relayUrl),
              !p.sessionToken.isEmpty, !p.userId.isEmpty, !p.deviceId.isEmpty, !p.hostId.isEmpty else {
            diag("fromBundledPairFile: malformed pair JSON")
            return nil
        }
        diag("fromBundledPairFile: building lifecycle with userId=\(p.userId.prefix(20))")
        return AppLifecycle(
            relayUrl: url,
            sessionToken: p.sessionToken,
            userId: UserId(p.userId),
            deviceId: DeviceId(p.deviceId),
            hostId: HostId(p.hostId)
        )
    }

    /// 環境変数が揃っていれば AppLifecycle を作って返す. 1 つでも欠けたら nil.
    @MainActor
    static func fromEnvironment() -> AppLifecycle? {
        let env = ProcessInfo.processInfo.environment
        guard
            let relayString = env["CODEX_LINK_RELAY_URL"],
            let relayUrl = URL(string: relayString),
            let token = env["CODEX_LINK_SESSION_TOKEN"], !token.isEmpty,
            let userId = env["CODEX_LINK_USER_ID"], !userId.isEmpty,
            let deviceId = env["CODEX_LINK_DEVICE_ID"], !deviceId.isEmpty,
            let hostId = env["CODEX_LINK_HOST_ID"], !hostId.isEmpty
        else {
            return nil
        }
        return AppLifecycle(
            relayUrl: relayUrl,
            sessionToken: token,
            userId: UserId(userId),
            deviceId: DeviceId(deviceId),
            hostId: HostId(hostId)
        )
    }
}

private struct OnboardingView: View {
    let onConnect: (AppLifecycle) -> Void

    @State private var relayUrl: String = Bundle.main
        .object(forInfoDictionaryKey: "CodexLinkRelayURL") as? String
        ?? "https://codex-link-p2p.kitepon.dynv6.net"
    @State private var sessionToken: String = ""
    @State private var userId: String = ""
    @State private var deviceId: String = ""
    @State private var hostId: String = ""
    @State private var pasteError: String?

    /// クリップボードの JSON で 5 フィールドを一括埋めする (実機テスト用).
    /// 期待する形式 (Mac 側 helper script `scripts/pair-to-clipboard.sh` で生成):
    ///   {"relayUrl":"...","sessionToken":"...","userId":"...","deviceId":"...","hostId":"..."}
    private func pasteFromClipboard() {
        guard let text = UIPasteboard.general.string else {
            pasteError = "Clipboard is empty"
            return
        }
        guard let data = text.data(using: .utf8) else {
            pasteError = "Invalid clipboard content"
            return
        }
        struct Payload: Decodable {
            let relayUrl: String?
            let sessionToken: String
            let userId: String
            let deviceId: String
            let hostId: String
        }
        do {
            let p = try JSONDecoder().decode(Payload.self, from: data)
            if let r = p.relayUrl, !r.isEmpty { self.relayUrl = r }
            self.sessionToken = p.sessionToken
            self.userId = p.userId
            self.deviceId = p.deviceId
            self.hostId = p.hostId
            self.pasteError = nil
        } catch {
            pasteError = "Not a valid pairing JSON: \(error.localizedDescription)"
        }
    }

    var canConnect: Bool {
        URL(string: relayUrl) != nil
            && !sessionToken.isEmpty
            && !userId.isEmpty
            && !deviceId.isEmpty
            && !hostId.isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Relay") {
                    TextField("Relay URL", text: $relayUrl)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }
                Section("Pairing (Mac Host から)") {
                    Button {
                        pasteFromClipboard()
                    } label: {
                        Label("Paste from Clipboard (JSON)", systemImage: "doc.on.clipboard")
                    }
                    if let pasteError {
                        Text(pasteError)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                    TextField("Session token", text: $sessionToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("User ID (usr_...)", text: $userId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Device ID (dev_...)", text: $deviceId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Host ID (hst_...)", text: $hostId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    Button("Connect") {
                        diag("Connect tapped, relayUrl=\(relayUrl), userId=\(userId.prefix(20))")
                        guard let url = URL(string: relayUrl) else {
                            diag("URL parse FAILED for \(relayUrl)")
                            return
                        }
                        let lc = AppLifecycle(
                            relayUrl: url,
                            sessionToken: sessionToken,
                            userId: UserId(userId),
                            deviceId: DeviceId(deviceId),
                            hostId: HostId(hostId)
                        )
                        diag("AppLifecycle created, calling onConnect")
                        onConnect(lc)
                    }
                    .disabled(!canConnect)
                }
            }
            .navigationTitle("Codex Link")
        }
    }
}

#Preview {
    ContentView()
}
