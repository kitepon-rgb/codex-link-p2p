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

    public init(lifecycle: AppLifecycle, uiState: CodexLinkUIState) {
        self.lifecycle = lifecycle
        self.uiState = uiState
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let tid = selectedThreadId ?? lifecycle.projection.orderedThreadIds.first {
                threadView(threadId: tid)
            } else {
                placeholder
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("Codex Link").font(.headline)
            Spacer()
            phaseLabel
            pathBadge
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var phaseLabel: some View {
        let text: String
        switch lifecycle.phase {
        case .idle: text = "idle"
        case .signalingConnecting: text = "signaling…"
        case .signalingOpen: text = "signaling open"
        case .awaitingTurnCredential: text = "turn…"
        case .peerOffering: text = "offering…"
        case .peerConnecting: text = "ice…"
        case .peerOpen: text = "open"
        case .error(let m): text = "err: \(m)"
        }
        return Text(text).font(.caption).foregroundColor(.secondary)
    }

    private var pathBadge: some View {
        Text(uiState.badgeText(for: uiState.connectionPath))
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(uiState.badgeColor(for: uiState.connectionPath).opacity(0.3))
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder
    private func threadView(threadId: ThreadId) -> some View {
        if let thread = lifecycle.projection.threads[threadId] {
            VStack(spacing: 0) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(thread.transcript, id: \.id) { item in
                            transcriptRow(item: item)
                        }
                        if !thread.streamingAssistant.isEmpty {
                            transcriptRow(item: TranscriptItem(
                                id: "streaming",
                                role: .assistant,
                                content: thread.streamingAssistant
                            ))
                            .opacity(0.6)
                        }
                        if let pending = thread.pendingApproval {
                            approvalCard(pending)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                }
                Divider()
                inputBar(threadId: threadId)
            }
        }
    }

    @ViewBuilder
    private func transcriptRow(item: TranscriptItem) -> some View {
        HStack(alignment: .top) {
            Text(item.role.rawValue)
                .font(.caption2.bold())
                .foregroundColor(.secondary)
                .frame(width: 70, alignment: .leading)
            Text(item.content)
                .font(.body)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func approvalCard(_ req: ApprovalRequest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Approval needed").font(.subheadline.bold())
            Text(req.summary).font(.caption)
            HStack {
                Button("Approve") {
                    lifecycle.respondApproval(
                        ApprovalDecision(requestId: req.requestId, approved: true)
                    )
                }.buttonStyle(.borderedProminent)
                Button("Deny") {
                    lifecycle.respondApproval(
                        ApprovalDecision(requestId: req.requestId, approved: false)
                    )
                }.buttonStyle(.bordered)
            }
        }
        .padding(8)
        .background(Color.yellow.opacity(0.15))
        .cornerRadius(8)
    }

    private func inputBar(threadId: ThreadId) -> some View {
        HStack {
            TextField("Message…", text: $input)
                .textFieldStyle(.roundedBorder)
            Button("Send") {
                let trimmed = input.trimmingCharacters(in: .whitespaces)
                guard !trimmed.isEmpty else { return }
                lifecycle.submitTurn(threadId: threadId, input: trimmed)
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
