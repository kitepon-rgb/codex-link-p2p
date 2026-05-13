// iPhone 側の SessionProjection — DataChannel 上の CodexLinkSessionFrame を
// 集約して transcript / timeline / approval などのビュー可能な状態を作る.
//
// Mac Host 側 (session.ts) の projection を mirror した state machine. iPhone
// は DataChannel から受け取った event を順次反映するだけ (snapshot で初期化).

import Foundation

@MainActor
public final class SessionProjection: ObservableObject {
    @Published public private(set) var hostId: HostId?
    @Published public private(set) var capabilities: HostCapabilities?
    @Published public private(set) var projects: [ProjectDescriptor] = []
    @Published public private(set) var threads: [ThreadId: ThreadView] = [:]
    @Published public private(set) var orderedThreadIds: [ThreadId] = []
    @Published public private(set) var latestSequence: SequenceNumber = SequenceNumber(0)
    @Published public private(set) var lastError: SessionError?

    public init() {}

    public struct ThreadView: Sendable, Equatable {
        public var threadId: ThreadId
        public var title: String
        public var status: TurnStatus
        public var transcript: [TranscriptItem]
        public var timeline: [TimelineEntry]
        public var pendingApproval: ApprovalRequest?
        // assistant.delta はストリーミング表示用. final で transcript に push.
        public var streamingAssistant: String

        public init(
            threadId: ThreadId, title: String, status: TurnStatus,
            transcript: [TranscriptItem] = [],
            timeline: [TimelineEntry] = [],
            pendingApproval: ApprovalRequest? = nil,
            streamingAssistant: String = ""
        ) {
            self.threadId = threadId
            self.title = title
            self.status = status
            self.transcript = transcript
            self.timeline = timeline
            self.pendingApproval = pendingApproval
            self.streamingAssistant = streamingAssistant
        }
    }

    public struct SessionError: Sendable, Equatable {
        public let code: String
        public let message: String
        public let threadId: ThreadId?
    }

    // ===== Frame 入口 =====

    public func apply(_ frame: CodexLinkSessionFrame) {
        switch frame {
        case .event(let e):
            applyEvent(e)
        case .snapshotResponse(let r):
            applySnapshot(r.projection)
        case .uiAction, .snapshotRequest, .ack:
            // iPhone 側に届く方向ではない. 無視.
            break
        }
    }

    public func applySnapshot(_ p: CodexLinkProjection) {
        hostId = p.hostId
        capabilities = p.capabilities
        projects = p.projects
        var newThreads: [ThreadId: ThreadView] = [:]
        var order: [ThreadId] = []
        for t in p.threads {
            newThreads[t.threadId] = ThreadView(
                threadId: t.threadId,
                title: t.title,
                status: t.status,
                transcript: t.transcript,
                timeline: t.timeline,
                pendingApproval: t.pendingApproval
            )
            order.append(t.threadId)
        }
        threads = newThreads
        orderedThreadIds = order
        latestSequence = p.latestSequence
    }

    public func applyEvent(_ event: CodexLinkEvent) {
        if event.sequence > latestSequence {
            latestSequence = event.sequence
        }
        switch event {
        case .hostCapabilitiesUpdated(_, _, let cap):
            capabilities = cap
            hostId = cap.hostId
        case .projectListUpdated(_, _, let p):
            projects = p
        case .threadStarted(_, _, let tid, _, let title):
            if threads[tid] == nil {
                threads[tid] = ThreadView(threadId: tid, title: title, status: .idle)
                orderedThreadIds.append(tid)
            }
        case .turnStatusChanged(_, _, let tid, let s):
            mutating(tid) { $0.status = s }
        case .assistantDelta(_, _, let tid, let delta):
            mutating(tid) { $0.streamingAssistant += delta }
        case .assistantFinal(_, _, let tid, let text):
            mutating(tid) { view in
                view.transcript.append(
                    TranscriptItem(id: "a_\(latestSequence.rawValue)", role: .assistant, content: text)
                )
                view.streamingAssistant = ""
            }
        case .transcriptItemRecorded(_, _, let tid, let item):
            mutating(tid) { $0.transcript.append(item) }
        case .timelineItemStarted(_, _, let tid, let id, let k, let l):
            mutating(tid) {
                $0.timeline.append(TimelineEntry(itemId: id, kind: k, label: l, outcome: nil))
            }
        case .timelineItemCompleted(_, _, let tid, let id, let o):
            mutating(tid) { view in
                if let idx = view.timeline.firstIndex(where: { $0.itemId == id }) {
                    let existing = view.timeline[idx]
                    view.timeline[idx] = TimelineEntry(
                        itemId: existing.itemId,
                        kind: existing.kind,
                        label: existing.label,
                        outcome: o
                    )
                }
            }
        case .approvalRequested(_, _, let req):
            mutating(req.threadId) { $0.pendingApproval = req }
        case .approvalResolved(_, _, let tid, _):
            mutating(tid) { $0.pendingApproval = nil }
        case .rateLimitUpdated:
            // 表示用. 今は無視 (Phase 7 で UI に反映可).
            break
        case .errorReported(_, _, let tid, let code, let msg):
            lastError = SessionError(code: code, message: msg, threadId: tid)
        }
    }

    private func mutating(_ tid: ThreadId, _ apply: (inout ThreadView) -> Void) {
        var view = threads[tid] ?? ThreadView(
            threadId: tid, title: "Untitled", status: .idle
        )
        apply(&view)
        threads[tid] = view
        if !orderedThreadIds.contains(tid) {
            orderedThreadIds.append(tid)
        }
    }
}
