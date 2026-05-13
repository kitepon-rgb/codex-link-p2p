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
import CodexLinkIOS

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
        } else if let envLifecycle = AutoConnect.fromEnvironment() {
            CodexLinkRootView(lifecycle: envLifecycle, uiState: uiState)
                .onAppear {
                    self.lifecycle = envLifecycle
                    envLifecycle.start()
                }
        } else {
            OnboardingView { lc in
                self.lifecycle = lc
                lc.start()
            }
        }
    }
}

private enum AutoConnect {
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
                        guard let url = URL(string: relayUrl) else { return }
                        let lc = AppLifecycle(
                            relayUrl: url,
                            sessionToken: sessionToken,
                            userId: UserId(userId),
                            deviceId: DeviceId(deviceId),
                            hostId: HostId(hostId)
                        )
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
