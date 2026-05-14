// SessionProjection — DataChannel 上で流れる CodexLinkEvent と SnapshotResponse
// を取り込んで、iPhone UI に必要な「現状」を保持する.
//
// 親リポ (broker 版) の SessionProjection.swift をベースに、p2p の
// SessionSnapshotResponse 受信 → state 再構築 を上乗せした拡張版.

import Foundation

public struct CodexLinkProjectionState: Equatable, Sendable {
    public private(set) var hostId: HostId?
    public private(set) var account: HostChatGptAccount?
    public private(set) var capabilities: HostCapabilities?
    public private(set) var projects: [ProjectRef] = []
    public private(set) var threadsById: [ThreadId: ThreadRef] = [:]
    public private(set) var turnStatus: [TurnId: TurnStatus] = [:]
    public private(set) var transcript: [TranscriptItem] = []
    public private(set) var timeline: [TimelineEntry] = []
    public private(set) var approvals: [ApprovalRequest] = []
    public private(set) var finalResponses: [TurnId: String] = [:]
    public private(set) var streamingByThread: [ThreadId: String] = [:]
    public private(set) var diagnostics: [DiagnosticEvent] = []
    public private(set) var latestError: String?
    public private(set) var latestSequence: Int = 0

    public init() {}

    public mutating func clearLatestError() {
        latestError = nil
    }

    /// SnapshotResponse 受信時に呼ぶ. 既存 state を全て projection で置換.
    public mutating func applySnapshot(_ projection: CodexLinkProjection) {
        hostId = projection.hostId
        account = projection.account
        capabilities = projection.capabilities
        projects = projection.projects
        threadsById = [:]
        turnStatus = [:]
        transcript = []
        timeline = []
        approvals = []
        finalResponses = [:]
        streamingByThread = [:]
        for tp in projection.threads {
            threadsById[tp.thread.id] = tp.thread
            if let turnId = tp.currentTurnId {
                turnStatus[turnId] = tp.status
            }
            transcript.append(contentsOf: tp.transcript)
            timeline.append(contentsOf: tp.timeline)
            if let pending = tp.pendingApproval {
                approvals.append(pending)
            }
            if !tp.streamingAssistant.isEmpty {
                streamingByThread[tp.thread.id] = tp.streamingAssistant
            }
        }
        latestSequence = projection.latestSequence
    }

    public mutating func apply(_ event: CodexLinkEvent) {
        switch event {
        case .hostAccountUpdated(let hostId, let acc):
            if self.hostId == hostId { self.account = acc }
        case .hostCapabilitiesUpdated(let hostId, let caps):
            if self.hostId == hostId || self.hostId == nil {
                self.hostId = hostId
                self.capabilities = caps
            }
        case .projectListUpdated(_, let projects):
            self.projects = projects
        case .threadStarted(let thread):
            threadsById[thread.id] = thread
        case .turnStatusChanged(_, let turnId, let status):
            turnStatus[turnId] = status
        case .assistantDelta(let threadId, _, let text):
            streamingByThread[threadId, default: ""] += text
        case .assistantFinal(let threadId, let turnId, let itemId, let text):
            streamingByThread.removeValue(forKey: threadId)
            finalResponses[turnId] = text
            recordTranscriptItem(TranscriptItem(id: itemId, role: .assistant, text: text))
        case .transcriptItemRecorded(_, _, let itemId, let role, let text):
            recordTranscriptItem(TranscriptItem(id: itemId, role: role, text: text))
        case .timelineItemStarted(_, let turnId, let itemId, let label, let detail):
            upsertTimelineItem(TimelineEntry(itemId: itemId, turnId: turnId, label: label, detail: detail, status: .running))
        case .timelineItemCompleted(_, _, let itemId, let status):
            if let i = timeline.firstIndex(where: { $0.itemId == itemId }) {
                timeline[i].status = status
            }
        case .approvalRequested(let request):
            if !approvals.contains(where: { $0.id == request.id }) {
                approvals.append(request)
            }
            turnStatus[request.turnId] = .waitingForApproval
        case .approvalResolved(let requestId, _):
            approvals.removeAll { $0.id == requestId }
        case .rateLimitUpdated:
            break
        case .diagnosticReported(let diagnostic):
            diagnostics.append(diagnostic)
        case .errorReported(_, let message):
            latestError = message
        }
    }

    public func liveActivityState(projectId: ProjectId, turnId: TurnId) -> LiveActivityState {
        let hostName = capabilities?.hostId.rawValue ?? "Host"
        let projectName = projects.first(where: { $0.id == projectId })?.name ?? "Project"
        let status = turnStatus[turnId] ?? .idle
        let latestText = transcript.last(where: { $0.role == .assistant })?.text
        return LiveActivityState(
            hostName: hostName,
            projectName: projectName,
            status: status,
            latestText: latestText,
            approvalRequired: approvals.contains(where: { $0.turnId == turnId })
        )
    }

    public func streamingAssistant(for threadId: ThreadId) -> String {
        streamingByThread[threadId] ?? ""
    }

    public func transcript(for _: ThreadId) -> [TranscriptItem] {
        return transcript
    }

    public func timeline(for _: ThreadId) -> [TimelineEntry] {
        return timeline
    }

    public func pendingApproval(for threadId: ThreadId) -> ApprovalRequest? {
        approvals.first(where: { $0.threadId == threadId })
    }

    public func orderedThreadIds() -> [ThreadId] {
        Array(threadsById.keys)
    }

    public func thread(_ id: ThreadId) -> ThreadRef? {
        threadsById[id]
    }

    private mutating func recordTranscriptItem(_ item: TranscriptItem) {
        if let i = transcript.firstIndex(where: { $0.id == item.id }) {
            transcript[i] = item
            return
        }
        transcript.append(item)
    }

    private mutating func upsertTimelineItem(_ entry: TimelineEntry) {
        if let i = timeline.firstIndex(where: { $0.itemId == entry.itemId }) {
            timeline[i] = entry
            return
        }
        timeline.append(entry)
    }
}

/// `@Published` で SwiftUI が観測できるようにする ObservableObject ラッパ.
@MainActor
public final class SessionProjection: ObservableObject {
    @Published public private(set) var state: CodexLinkProjectionState = CodexLinkProjectionState()

    public init() {}

    public func apply(_ event: CodexLinkEvent) {
        state.apply(event)
    }

    public func applySnapshot(_ projection: CodexLinkProjection) {
        state.applySnapshot(projection)
    }

    public func clearLatestError() {
        state.clearLatestError()
    }
}
