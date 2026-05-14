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
            pathBadge
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
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
