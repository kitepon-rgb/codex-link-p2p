// CodexLinkRootView — iPhone app のルート画面.
//
// 最低限の MVP UI:
// - 接続フェーズ表示 (connecting / open / error)
// - 接続経路バッジ (direct / srflx / turn)
// - スレッド一覧
// - 選択中スレッドの transcript + timeline
// - 入力欄 → submitTurn

import Foundation
import SwiftUI

@MainActor
public struct CodexLinkRootView: View {

    @ObservedObject public var lifecycle: AppLifecycle
    @ObservedObject public var uiState: CodexLinkUIState

    @State private var selectedThreadId: ThreadId?
    @State private var input: String = ""
    @State private var showThreadsSheet: Bool = false
    @State private var showSettingsSheet: Bool = false

    public init(lifecycle: AppLifecycle, uiState: CodexLinkUIState) {
        self.lifecycle = lifecycle
        self.uiState = uiState
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let tid = selectedThreadId ?? lifecycle.projection.state.orderedThreadIds().first {
                threadView(threadId: tid)
            } else {
                placeholder
            }
        }
        .sheet(isPresented: $showThreadsSheet) {
            ThreadsSheet(
                state: lifecycle.projection.state,
                selected: $selectedThreadId
            ) { showThreadsSheet = false }
        }
        .sheet(isPresented: $showSettingsSheet) {
            SettingsSheet(lifecycle: lifecycle) { showSettingsSheet = false }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                showThreadsSheet = true
            } label: {
                Image(systemName: "bubble.left.and.bubble.right")
            }
            Text(currentThreadTitle).font(.headline).lineLimit(1)
            Spacer()
            statusIndicator
            pathBadge
            Button {
                showSettingsSheet = true
            } label: {
                Image(systemName: "gearshape")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var currentThreadTitle: String {
        guard let tid = selectedThreadId ?? lifecycle.projection.state.orderedThreadIds().first,
              let thread = lifecycle.projection.state.thread(tid) else {
            return "Codex Link"
        }
        return thread.title ?? "Untitled thread"
    }

    private var statusIndicator: some View {
        let state = lifecycle.projection.state
        let visibleThread = selectedThreadId ?? state.orderedThreadIds().first
        let pending = visibleThread.flatMap { state.pendingApproval(for: $0) } != nil
        let running = state.turnStatus.values.contains(.running)
        let (label, color): (String, Color)
        if pending {
            (label, color) = ("承認待ち", .orange)
        } else if running {
            (label, color) = ("実行中", .blue)
        } else {
            (label, color) = ("待機", .secondary)
        }
        return Text(label)
            .font(.caption2.bold())
            .foregroundColor(color)
    }

    /// バッジは BOOTSTRAP.md の「path 単独 ↔ UI」設計どおり、
    /// **connectionPath を唯一のソース** として表示する.
    /// 唯一の例外は phase=.error の時 (赤 "エラー" を上書き).
    ///
    /// 過去の実装は phase=.peerOpen で「接続済」(緑) をデフォルトに出し、その
    /// 後 connectionPath が確定すると「直結」「中継」へ上書きしていたが、これ
    /// だと badge が緑→緑へ flicker し、ユーザーが現在の経路 (直結 or 中継) を
    /// 視覚的に把握できなかった. その実装をやめて純粋に path だけを反映する.
    private var pathBadge: some View {
        let (text, color): (String, Color) = {
            if case .error = lifecycle.phase {
                return ("エラー", .red)
            }
            switch lifecycle.connectionPath {
            case .connecting:
                return ("接続中…", .gray)
            case .direct:
                return ("直結", .green)
            case .stunReflexive:
                return ("直結 (NAT越え)", .green)
            case .turnRelayed:
                return ("中継", .yellow)
            case .failed:
                return ("切断", .red)
            }
        }()
        return Text(text)
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.3))
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder
    private func threadView(threadId: ThreadId) -> some View {
        let state = lifecycle.projection.state
        if let thread = state.thread(threadId) {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 6) {
                            ForEach(state.transcript(for: threadId), id: \.id) { item in
                                transcriptRow(item: item).id(item.id)
                            }
                            ForEach(state.timeline(for: threadId), id: \.itemId) { entry in
                                timelineRow(entry: entry).id("tl-\(entry.itemId.rawValue)")
                            }
                            let streaming = state.streamingAssistant(for: threadId)
                            if !streaming.isEmpty,
                               let streamingId = ItemId(rawValue: "streaming-\(threadId.rawValue)") {
                                transcriptRow(item: TranscriptItem(
                                    id: streamingId,
                                    role: .assistant,
                                    text: streaming
                                ))
                                .opacity(0.6)
                                .id("streaming")
                            }
                            if let pending = state.pendingApproval(for: threadId) {
                                approvalCard(pending).id("approval")
                            }
                            // Anchor for auto-scroll-to-bottom.
                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                    }
                    .onChange(of: state.transcript(for: threadId).count) { _ in
                        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                    .onChange(of: state.streamingAssistant(for: threadId)) { _ in
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                    .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                Divider()
                inputBar(thread: thread)
            }
        }
    }

    @ViewBuilder
    private func transcriptRow(item: TranscriptItem) -> some View {
        HStack(alignment: .top) {
            Text(item.role.rawValue)
                .font(.caption2.bold())
                .foregroundColor(item.role == .assistant ? .blue : .secondary)
                .frame(width: 70, alignment: .leading)
            Text(item.text)
                .font(.body)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func timelineRow(entry: TimelineEntry) -> some View {
        let (icon, color): (String, Color) = {
            switch entry.status {
            case .running: return ("circle.dotted", .blue)
            case .completed: return ("checkmark.circle", .green)
            case .failed: return ("xmark.circle", .red)
            case .declined: return ("hand.raised", .orange)
            }
        }()
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).foregroundColor(color)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.label).font(.caption.bold())
                if let detail = entry.detail, !detail.isEmpty {
                    Text(detail).font(.caption2).foregroundColor(.secondary).lineLimit(3)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(6)
        .background(Color.secondary.opacity(0.08))
        .cornerRadius(6)
    }

    @ViewBuilder
    private func approvalCard(_ req: ApprovalRequest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(req.title).font(.subheadline.bold())
            Text(req.detail).font(.caption)
            HStack {
                ForEach(req.availableDecisions, id: \.self) { kind in
                    approvalButton(req: req, kind: kind)
                }
            }
        }
        .padding(8)
        .background(Color.yellow.opacity(0.15))
        .cornerRadius(8)
    }

    @ViewBuilder
    private func approvalButton(req: ApprovalRequest, kind: ApprovalDecisionKind) -> some View {
        let action: () -> Void = {
            lifecycle.respondApproval(
                ApprovalDecision(requestId: req.id, decision: kind)
            )
        }
        if kind == .accept {
            Button(decisionLabel(kind), action: action)
                .buttonStyle(.borderedProminent)
        } else {
            Button(decisionLabel(kind), action: action)
                .buttonStyle(.bordered)
        }
    }

    private func decisionLabel(_ kind: ApprovalDecisionKind) -> String {
        switch kind {
        case .accept: return "Approve"
        case .acceptForSession: return "Always allow"
        case .decline: return "Deny"
        case .cancel: return "Cancel"
        }
    }

    private func inputBar(thread: ThreadRef) -> some View {
        HStack {
            TextField("Message…", text: $input)
                .textFieldStyle(.roundedBorder)
            Button("Send") {
                let trimmed = input.trimmingCharacters(in: .whitespaces)
                guard !trimmed.isEmpty else { return }
                lifecycle.submitTurn(
                    projectId: thread.projectId,
                    threadId: thread.id,
                    input: trimmed
                )
                input = ""
            }.disabled(input.isEmpty)
        }
        .padding(8)
    }

    private var placeholder: some View {
        VStack {
            Spacer()
            Text("Waiting for Host…").foregroundColor(.secondary)
            Spacer()
        }
    }
}

// MARK: - Threads sheet

@MainActor
private struct ThreadsSheet: View {
    let state: CodexLinkProjectionState
    @Binding var selected: ThreadId?
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section("Projects") {
                    if state.projects.isEmpty {
                        Text("プロジェクトは未取得です").foregroundColor(.secondary)
                    } else {
                        ForEach(state.projects) { p in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.name).font(.body)
                                Text(p.pathLabel).font(.caption).foregroundColor(.secondary)
                            }
                        }
                    }
                }
                Section("Threads") {
                    if state.orderedThreadIds().isEmpty {
                        Text("スレッドはまだありません. Mac で Codex に prompt を投げると追加されます.")
                            .foregroundColor(.secondary)
                    } else {
                        ForEach(state.orderedThreadIds(), id: \.rawValue) { tid in
                            if let thread = state.thread(tid) {
                                Button {
                                    selected = tid
                                    onClose()
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(thread.title ?? "Untitled").font(.body)
                                            Text(thread.id.rawValue).font(.caption2).foregroundColor(.secondary)
                                        }
                                        Spacer()
                                        if selected == tid {
                                            Image(systemName: "checkmark")
                                        }
                                    }
                                }
                                .foregroundColor(.primary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Threads")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { onClose() }
                }
            }
        }
    }
}

// MARK: - Settings sheet

@MainActor
private struct SettingsSheet: View {
    @ObservedObject var lifecycle: AppLifecycle
    let onClose: () -> Void
    @State private var shareItems: [URL] = []
    @State private var showShare: Bool = false

    var body: some View {
        let state = lifecycle.projection.state
        return NavigationStack {
            Form {
                Section("Host") {
                    if let caps = state.capabilities {
                        labeledRow("Host ID", caps.hostId.rawValue)
                        labeledRow("Platform", caps.platform)
                        labeledRow("Codex version", caps.codexVersion)
                    } else {
                        Text("ホスト情報は未取得です").foregroundColor(.secondary)
                    }
                    if let account = state.account {
                        labeledRow("ChatGPT", account.email)
                        if let plan = account.planType {
                            labeledRow("Plan", plan)
                        }
                    }
                }
                Section("Connection") {
                    labeledRow("Path", pathLabel)
                    labeledRow("Phase", phaseLabel)
                    if let err = state.latestError {
                        labeledRow("Last error", err)
                    }
                    Button {
                        lifecycle.reconnect(reason: "user tapped Settings → Reconnect")
                        onClose()
                    } label: {
                        Label("Reconnect", systemImage: "arrow.clockwise")
                    }
                }
                Section("Diagnostics") {
                    if state.diagnostics.isEmpty {
                        Text("診断情報なし").foregroundColor(.secondary)
                    } else {
                        ForEach(state.diagnostics.suffix(20), id: \.message) { d in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("[\(d.severity.rawValue)] \(d.scope)").font(.caption.bold())
                                Text(d.message).font(.caption)
                            }
                        }
                    }
                    Button {
                        if let url = exportDebugLog() {
                            shareItems = [url]
                            showShare = true
                        }
                    } label: {
                        Label("Share debug log", systemImage: "square.and.arrow.up")
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { onClose() }
                }
            }
            .modifier(ShareLogModifier(isPresented: $showShare, items: shareItems))
        }
    }

    /// `Documents/codex-link-debug.log` のスナップショットを `tmp/` に複製し、
    /// 共有用 URL を返す. 直接 Documents/ を共有すると iOS の sandbox で挙動が
    /// 不安定なので、必ず tmp に複製してから ShareSheet に渡す.
    private func exportDebugLog() -> URL? {
        let fm = FileManager.default
        guard let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
        let src = docs.appendingPathComponent("codex-link-debug.log")
        guard fm.fileExists(atPath: src.path) else { return nil }
        let stamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let dst = fm.temporaryDirectory.appendingPathComponent("codex-link-debug-\(stamp).log")
        try? fm.removeItem(at: dst)
        do {
            try fm.copyItem(at: src, to: dst)
            return dst
        } catch {
            return nil
        }
    }

    private var pathLabel: String {
        switch lifecycle.connectionPath {
        case .connecting: return "Connecting…"
        case .direct: return "Direct (LAN)"
        case .stunReflexive: return "Direct (NAT越え)"
        case .turnRelayed: return "Relayed (TURN)"
        case .failed: return "Failed"
        }
    }

    private var phaseLabel: String {
        switch lifecycle.phase {
        case .idle: return "Idle"
        case .signalingConnecting: return "Signaling…"
        case .signalingOpen: return "Signaling open"
        case .awaitingTurnCredential: return "Awaiting TURN credential"
        case .peerOffering: return "Offering"
        case .peerConnecting: return "Peer connecting"
        case .peerOpen: return "Peer open"
        case .error(let m): return "Error: \(m)"
        }
    }

    @ViewBuilder
    private func labeledRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundColor(.secondary)
            Spacer()
            Text(value).font(.caption.monospaced()).textSelection(.enabled)
        }
    }
}

// UIActivityViewController を SwiftUI でラップ. iOS だけで動く. macOS では
// no-op として動作させるため、modifier 経由で iOS/macOS の差分を吸収する.
#if canImport(UIKit) && !os(watchOS)
import UIKit

private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

private struct ShareLogModifier: ViewModifier {
    @Binding var isPresented: Bool
    let items: [URL]
    func body(content: Content) -> some View {
        content.sheet(isPresented: $isPresented) {
            ShareSheet(items: items)
        }
    }
}
#else
private struct ShareLogModifier: ViewModifier {
    @Binding var isPresented: Bool
    let items: [URL]
    func body(content: Content) -> some View {
        content   // macOS では no-op (SwiftPM 単体テスト用)
    }
}
#endif
