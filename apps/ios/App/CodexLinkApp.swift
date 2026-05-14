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
import AVFoundation
import CodexLinkIOS

/// 診断用: NSLog に出すと同時に Documents/codex-link-debug.log に追記.
/// devicectl device copy from で取り出して解析する.
///
/// DEBUG ビルド時のみ動作する. Release では no-op になり file writer も走らない.
/// 実機の本番診断は Console.app 経由 (os_log) に任せる.
func diag(_ message: String) {
    #if DEBUG
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
    #endif
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
        } else if let autoLc = AutoConnect.resolve() {
            CodexLinkRootView(lifecycle: autoLc, uiState: uiState)
                .onAppear {
                    diag("ContentView onAppear: auto-connect path")
                    self.lifecycle = autoLc
                    autoLc.start()
                    diag("autoLc.start() returned")
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
    /// 起動時に試す自動接続候補をまとめて評価する.
    /// 優先順位:
    ///   1. (DEBUG のみ) Documents/codex-link-pair.json
    ///   2. 環境変数 (CODEX_LINK_RELAY_URL ...)
    /// どれも該当しなければ nil. その場合は QR pairing 画面 (OnboardingView) を出す.
    @MainActor
    static func resolve() -> AppLifecycle? {
        #if DEBUG
        if let lc = fromBundledPairFile() {
            return lc
        }
        #endif
        if let lc = fromEnvironment() {
            return lc
        }
        return nil
    }

    #if DEBUG
    /// Documents/codex-link-pair.json があればそれから AppLifecycle を作る.
    /// devicectl device copy to で push して使う dev-only 経路.
    /// QR pairing が入ったらこの実装ごと削除して良い (DEBUG でも不要になる).
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
    #endif

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

    @State private var showScanner = false
    @State private var pairingStatus: String?
    @State private var pairingError: String?
    @State private var isPairing = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 88))
                    .foregroundStyle(.tint)
                Text("Codex Link")
                    .font(.largeTitle.bold())
                Text("Mac で `codex-link-host pair` を実行し、表示された QR を読み取ってください.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 24)

                Button {
                    pairingError = nil
                    pairingStatus = nil
                    showScanner = true
                } label: {
                    Label("Scan QR", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)
                .disabled(isPairing)
                .padding(.horizontal, 32)

                if isPairing {
                    ProgressView()
                }
                if let pairingStatus {
                    Text(pairingStatus)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let pairingError {
                    Text(pairingError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 24)
                        .multilineTextAlignment(.center)
                }
                Spacer()
            }
            .padding(.top, 60)
            .navigationTitle("")
            .navigationBarHidden(true)
            .sheet(isPresented: $showScanner) {
                QRScannerSheet { result in
                    showScanner = false
                    switch result {
                    case .cancelled:
                        return
                    case .scanned(let text):
                        handleScanned(text: text)
                    case .error(let message):
                        pairingError = message
                    }
                }
            }
        }
    }

    private func handleScanned(text: String) {
        diag("QR scanned, len=\(text.count)")
        guard let data = text.data(using: .utf8),
              let payload = try? JSONDecoder().decode(PairingQRPayload.self, from: data),
              let relayURL = URL(string: payload.relayUrl)
        else {
            pairingError = "QR の内容が pairing payload ではありません."
            return
        }
        pairingError = nil
        pairingStatus = "Relay に登録中…"
        isPairing = true
        Task {
            do {
                let lc = try await PairingFlow.exchange(
                    relayUrl: relayURL,
                    pairingCode: payload.pairingCode,
                    hostId: HostId(payload.hostId)
                )
                await MainActor.run {
                    isPairing = false
                    pairingStatus = "接続中…"
                    onConnect(lc)
                }
            } catch {
                await MainActor.run {
                    isPairing = false
                    pairingError = "Pairing 失敗: \(error.localizedDescription)"
                    diag("PairingFlow failed: \(error.localizedDescription)")
                }
            }
        }
    }
}

// MARK: - Pairing payload + REST flow

/// Mac CLI `codex-link-host pair` が QR にエンコードする payload と一致.
private struct PairingQRPayload: Decodable {
    let v: Int
    let relayUrl: String
    let pairingCode: String
    let hostId: String
}

private enum PairingFlow {
    /// QR から取り出した値で:
    ///   1. POST /api/device-session/register  → fresh (userId, deviceId, sessionToken)
    ///   2. POST /api/device-session/pair       → HostAccess grant
    /// を順に叩いて AppLifecycle を組み立てて返す.
    @MainActor
    static func exchange(
        relayUrl: URL,
        pairingCode: String,
        hostId: HostId
    ) async throws -> AppLifecycle {
        // 1. register: 新規 device session を作る (匿名 POST).
        let registerBody: [String: String] = [
            "displayName": Self.deviceDisplayName(),
            "platform": "ios",
        ]
        let registered: RegisterResponse = try await postJSON(
            url: relayUrl.appendingPathComponent("api/device-session/register"),
            body: registerBody,
            bearer: nil
        )

        // 2. pair: 受け取った sessionToken を Bearer に乗せて HostAccess を作る.
        let pairBody: [String: String] = [
            "pairingCode": pairingCode,
            "role": "operator",
        ]
        let _: PairResponse = try await postJSON(
            url: relayUrl.appendingPathComponent("api/device-session/pair"),
            body: pairBody,
            bearer: registered.sessionToken
        )

        return AppLifecycle(
            relayUrl: relayUrl,
            sessionToken: registered.sessionToken,
            userId: UserId(registered.userId),
            deviceId: DeviceId(registered.deviceId),
            hostId: hostId
        )
    }

    private static func deviceDisplayName() -> String {
        let model = UIDevice.current.model
        let name = UIDevice.current.name
        return name.isEmpty ? model : "\(name) (\(model))"
    }

    private struct RegisterResponse: Decodable {
        let userId: String
        let deviceId: String
        let sessionToken: String
    }
    private struct PairResponse: Decodable {
        let hostId: String
    }

    enum PairingError: LocalizedError {
        case httpStatus(Int, String)
        case decode(String)

        var errorDescription: String? {
            switch self {
            case .httpStatus(let code, let body): return "HTTP \(code): \(body)"
            case .decode(let msg): return "Decode error: \(msg)"
            }
        }
    }

    private static func postJSON<Response: Decodable>(
        url: URL,
        body: [String: String],
        bearer: String?
    ) async throws -> Response {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let bearer {
            req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw PairingError.httpStatus(0, "no HTTP response")
        }
        guard (200...299).contains(http.statusCode) else {
            let text = String(data: data, encoding: .utf8) ?? "<no body>"
            throw PairingError.httpStatus(http.statusCode, text)
        }
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw PairingError.decode(error.localizedDescription)
        }
    }
}

// MARK: - QR scanner

private enum QRScanResult {
    case scanned(String)
    case cancelled
    case error(String)
}

private struct QRScannerSheet: View {
    let onResult: (QRScanResult) -> Void

    var body: some View {
        NavigationStack {
            QRScannerView(onScan: { text in
                onResult(.scanned(text))
            }, onError: { msg in
                onResult(.error(msg))
            })
            .ignoresSafeArea()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onResult(.cancelled) }
                }
            }
        }
    }
}

private struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIViewController(context: Context) -> ScannerViewController {
        let vc = ScannerViewController()
        vc.coordinator = context.coordinator
        return vc
    }

    func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let parent: QRScannerView
        var didScan = false

        init(parent: QRScannerView) {
            self.parent = parent
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            if didScan { return }
            guard let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  obj.type == .qr,
                  let text = obj.stringValue else { return }
            didScan = true
            parent.onScan(text)
        }
    }

    final class ScannerViewController: UIViewController {
        weak var coordinator: Coordinator?
        private let session = AVCaptureSession()
        private var previewLayer: AVCaptureVideoPreviewLayer?
        private var didSetup = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            ensureCameraAuthorized { [weak self] granted in
                guard let self = self else { return }
                if !granted {
                    self.coordinator?.parent.onError(
                        "カメラの利用が許可されていません. 設定 > プライバシー > カメラ から Codex Link を有効にしてください."
                    )
                    return
                }
                self.setupSession()
                self.didSetup = true
                if self.isViewLoaded && self.view.window != nil {
                    self.startSession()
                }
            }
        }

        /// 権限が未確認なら requestAccess を呼んで結果を main で返す.
        /// 既に決まっていればその場で返す.
        private func ensureCameraAuthorized(completion: @escaping (Bool) -> Void) {
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:
                completion(true)
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    DispatchQueue.main.async { completion(granted) }
                }
            case .denied, .restricted:
                completion(false)
            @unknown default:
                completion(false)
            }
        }

        private func startSession() {
            if session.isRunning { return }
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.session.startRunning()
            }
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            // setupSession() は権限取得後にしか走らないため、didSetup が true の
            // 時だけ startSession する. それ以外は viewDidLoad の callback から
            // 起動される.
            if didSetup {
                startSession()
            }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            if session.isRunning {
                session.stopRunning()
            }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            previewLayer?.frame = view.bounds
        }

        private func setupSession() {
            guard let device = AVCaptureDevice.default(for: .video) else {
                coordinator?.parent.onError("カメラデバイスが見つかりません.")
                return
            }
            let input: AVCaptureDeviceInput
            do {
                input = try AVCaptureDeviceInput(device: device)
            } catch {
                coordinator?.parent.onError("カメラ初期化失敗: \(error.localizedDescription)")
                return
            }
            guard session.canAddInput(input) else {
                coordinator?.parent.onError("カメラ入力を追加できませんでした.")
                return
            }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                coordinator?.parent.onError("メタデータ出力を追加できませんでした.")
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(coordinator, queue: .main)
            output.metadataObjectTypes = [.qr]

            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.videoGravity = .resizeAspectFill
            preview.frame = view.bounds
            view.layer.addSublayer(preview)
            self.previewLayer = preview
        }
    }
}

#Preview {
    ContentView()
}
