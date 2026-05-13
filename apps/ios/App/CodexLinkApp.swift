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
        } else {
            OnboardingView { lc in
                self.lifecycle = lc
                lc.start()
            }
        }
    }
}

private struct OnboardingView: View {
    let onConnect: (AppLifecycle) -> Void

    @State private var relayUrl: String = Bundle.main
        .object(forInfoDictionaryKey: "CodexLinkRelayURL") as? String
        ?? "https://codex-link.kitepon.dynv6.net"
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
