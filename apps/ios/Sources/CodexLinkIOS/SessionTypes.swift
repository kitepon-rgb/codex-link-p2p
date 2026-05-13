// Session protocol types (DataChannel 上のみで流れる).
//
// TypeScript `packages/protocol/src/session.ts` の対応物. このファイルは
// Relay 経由では一切流れない (Relay は payload-blind).

import Foundation

// ===== Capabilities / Project =====

public struct HostCapabilities: Codable, Sendable, Equatable {
    public let hostId: HostId
    public let platform: String // "macos" | "windows" | "linux"
    public let codexVersion: String
    public let supportsApprovals: Bool

    public init(hostId: HostId, platform: String, codexVersion: String, supportsApprovals: Bool) {
        self.hostId = hostId
        self.platform = platform
        self.codexVersion = codexVersion
        self.supportsApprovals = supportsApprovals
    }
}

public struct ProjectDescriptor: Codable, Sendable, Equatable {
    public let id: String
    public let displayName: String
    public let path: String

    public init(id: String, displayName: String, path: String) {
        self.id = id
        self.displayName = displayName
        self.path = path
    }
}

// ===== Transcript / Timeline =====

public struct TranscriptItem: Codable, Sendable, Equatable {
    public enum Role: String, Codable, Sendable {
        case user, assistant, system
    }
    public let id: String
    public let role: Role
    public let content: String

    public init(id: String, role: Role, content: String) {
        self.id = id
        self.role = role
        self.content = content
    }
}

public enum TimelineItemKind: String, Codable, Sendable {
    case toolCall = "tool_call"
    case approval
    case reasoning
}

public enum TimelineItemOutcome: String, Codable, Sendable {
    case success, failure, cancelled
}

public struct TimelineEntry: Codable, Sendable, Equatable {
    public let itemId: String
    public let kind: TimelineItemKind
    public let label: String
    public let outcome: TimelineItemOutcome?

    public init(itemId: String, kind: TimelineItemKind, label: String, outcome: TimelineItemOutcome?) {
        self.itemId = itemId
        self.kind = kind
        self.label = label
        self.outcome = outcome
    }
}

// ===== Approval =====

public enum ApprovalKind: String, Codable, Sendable {
    case command, patch
    case fileWrite = "file_write"
    case network
}

public struct ApprovalRequest: Codable, Sendable, Equatable {
    public let requestId: RequestId
    public let threadId: ThreadId
    public let summary: String
    public let kind: ApprovalKind
    public let detail: String

    public init(requestId: RequestId, threadId: ThreadId, summary: String, kind: ApprovalKind, detail: String) {
        self.requestId = requestId
        self.threadId = threadId
        self.summary = summary
        self.kind = kind
        self.detail = detail
    }
}

public struct ApprovalDecision: Codable, Sendable, Equatable {
    public let requestId: RequestId
    public let approved: Bool
    public let reason: String?

    public init(requestId: RequestId, approved: Bool, reason: String? = nil) {
        self.requestId = requestId
        self.approved = approved
        self.reason = reason
    }
}

// ===== Turn status =====

public enum TurnStatus: String, Codable, Sendable {
    case idle, thinking, tool
    case awaitingApproval = "awaiting_approval"
    case error
}

// ===== CodexLinkEvent (discriminated union) =====

public enum CodexLinkEvent: Codable, Sendable, Equatable {
    case hostCapabilitiesUpdated(seq: SequenceNumber, ts: Int, capabilities: HostCapabilities)
    case projectListUpdated(seq: SequenceNumber, ts: Int, projects: [ProjectDescriptor])
    case threadStarted(seq: SequenceNumber, ts: Int, threadId: ThreadId, projectId: String, title: String)
    case turnStatusChanged(seq: SequenceNumber, ts: Int, threadId: ThreadId, status: TurnStatus)
    case assistantDelta(seq: SequenceNumber, ts: Int, threadId: ThreadId, delta: String)
    case assistantFinal(seq: SequenceNumber, ts: Int, threadId: ThreadId, text: String)
    case transcriptItemRecorded(seq: SequenceNumber, ts: Int, threadId: ThreadId, item: TranscriptItem)
    case timelineItemStarted(seq: SequenceNumber, ts: Int, threadId: ThreadId, itemId: String, kind: TimelineItemKind, label: String)
    case timelineItemCompleted(seq: SequenceNumber, ts: Int, threadId: ThreadId, itemId: String, outcome: TimelineItemOutcome)
    case approvalRequested(seq: SequenceNumber, ts: Int, request: ApprovalRequest)
    case approvalResolved(seq: SequenceNumber, ts: Int, threadId: ThreadId, decision: ApprovalDecision)
    case rateLimitUpdated(seq: SequenceNumber, ts: Int, remainingTokens: Int, resetAt: Int)
    case errorReported(seq: SequenceNumber, ts: Int, threadId: ThreadId?, code: String, message: String)

    public var sequence: SequenceNumber {
        switch self {
        case .hostCapabilitiesUpdated(let s, _, _),
             .projectListUpdated(let s, _, _),
             .threadStarted(let s, _, _, _, _),
             .turnStatusChanged(let s, _, _, _),
             .assistantDelta(let s, _, _, _),
             .assistantFinal(let s, _, _, _),
             .transcriptItemRecorded(let s, _, _, _),
             .timelineItemStarted(let s, _, _, _, _, _),
             .timelineItemCompleted(let s, _, _, _, _),
             .approvalRequested(let s, _, _),
             .approvalResolved(let s, _, _, _),
             .rateLimitUpdated(let s, _, _, _),
             .errorReported(let s, _, _, _, _):
            return s
        }
    }

    private enum K: String, CodingKey {
        case type, sequence, timestamp
        case capabilities, projects, threadId, projectId, title, status
        case delta, text, item, itemId, kind, label, outcome, request, decision
        case remainingTokens, resetAt, code, message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let type = try c.decode(String.self, forKey: .type)
        let seq = try c.decode(SequenceNumber.self, forKey: .sequence)
        let ts = try c.decode(Int.self, forKey: .timestamp)
        switch type {
        case "host.capabilities.updated":
            self = .hostCapabilitiesUpdated(
                seq: seq, ts: ts,
                capabilities: try c.decode(HostCapabilities.self, forKey: .capabilities)
            )
        case "project.list.updated":
            self = .projectListUpdated(
                seq: seq, ts: ts,
                projects: try c.decode([ProjectDescriptor].self, forKey: .projects)
            )
        case "thread.started":
            self = .threadStarted(
                seq: seq, ts: ts,
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                projectId: try c.decode(String.self, forKey: .projectId),
                title: try c.decode(String.self, forKey: .title)
            )
        case "turn.status.changed":
            self = .turnStatusChanged(
                seq: seq, ts: ts,
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                status: try c.decode(TurnStatus.self, forKey: .status)
            )
        case "assistant.delta":
            self = .assistantDelta(
                seq: seq, ts: ts,
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                delta: try c.decode(String.self, forKey: .delta)
            )
        case "assistant.final":
            self = .assistantFinal(
                seq: seq, ts: ts,
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                text: try c.decode(String.self, forKey: .text)
            )
        case "transcript.item.recorded":
            self = .transcriptItemRecorded(
                seq: seq, ts: ts,
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                item: try c.decode(TranscriptItem.self, forKey: .item)
            )
        case "timeline.item.started":
            self = .timelineItemStarted(
                seq: seq, ts: ts,
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                itemId: try c.decode(String.self, forKey: .itemId),
                kind: try c.decode(TimelineItemKind.self, forKey: .kind),
                label: try c.decode(String.self, forKey: .label)
            )
        case "timeline.item.completed":
            self = .timelineItemCompleted(
                seq: seq, ts: ts,
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                itemId: try c.decode(String.self, forKey: .itemId),
                outcome: try c.decode(TimelineItemOutcome.self, forKey: .outcome)
            )
        case "approval.requested":
            self = .approvalRequested(
                seq: seq, ts: ts,
                request: try c.decode(ApprovalRequest.self, forKey: .request)
            )
        case "approval.resolved":
            self = .approvalResolved(
                seq: seq, ts: ts,
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                decision: try c.decode(ApprovalDecision.self, forKey: .decision)
            )
        case "rate_limit.updated":
            self = .rateLimitUpdated(
                seq: seq, ts: ts,
                remainingTokens: try c.decode(Int.self, forKey: .remainingTokens),
                resetAt: try c.decode(Int.self, forKey: .resetAt)
            )
        case "error.reported":
            self = .errorReported(
                seq: seq, ts: ts,
                threadId: try c.decodeIfPresent(ThreadId.self, forKey: .threadId),
                code: try c.decode(String.self, forKey: .code),
                message: try c.decode(String.self, forKey: .message)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c,
                debugDescription: "unknown CodexLinkEvent type: \(type)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(sequence, forKey: .sequence)
        switch self {
        case .hostCapabilitiesUpdated(_, let ts, let cap):
            try c.encode("host.capabilities.updated", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encode(cap, forKey: .capabilities)
        case .projectListUpdated(_, let ts, let p):
            try c.encode("project.list.updated", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encode(p, forKey: .projects)
        case .threadStarted(_, let ts, let t, let p, let title):
            try c.encode("thread.started", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encode(t, forKey: .threadId)
            try c.encode(p, forKey: .projectId)
            try c.encode(title, forKey: .title)
        case .turnStatusChanged(_, let ts, let t, let s):
            try c.encode("turn.status.changed", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encode(t, forKey: .threadId)
            try c.encode(s, forKey: .status)
        case .assistantDelta(_, let ts, let t, let d):
            try c.encode("assistant.delta", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encode(t, forKey: .threadId)
            try c.encode(d, forKey: .delta)
        case .assistantFinal(_, let ts, let t, let text):
            try c.encode("assistant.final", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encode(t, forKey: .threadId)
            try c.encode(text, forKey: .text)
        case .transcriptItemRecorded(_, let ts, let t, let item):
            try c.encode("transcript.item.recorded", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encode(t, forKey: .threadId)
            try c.encode(item, forKey: .item)
        case .timelineItemStarted(_, let ts, let t, let id, let k, let l):
            try c.encode("timeline.item.started", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encode(t, forKey: .threadId)
            try c.encode(id, forKey: .itemId)
            try c.encode(k, forKey: .kind)
            try c.encode(l, forKey: .label)
        case .timelineItemCompleted(_, let ts, let t, let id, let o):
            try c.encode("timeline.item.completed", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encode(t, forKey: .threadId)
            try c.encode(id, forKey: .itemId)
            try c.encode(o, forKey: .outcome)
        case .approvalRequested(_, let ts, let r):
            try c.encode("approval.requested", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encode(r, forKey: .request)
        case .approvalResolved(_, let ts, let t, let d):
            try c.encode("approval.resolved", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encode(t, forKey: .threadId)
            try c.encode(d, forKey: .decision)
        case .rateLimitUpdated(_, let ts, let r, let reset):
            try c.encode("rate_limit.updated", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encode(r, forKey: .remainingTokens)
            try c.encode(reset, forKey: .resetAt)
        case .errorReported(_, let ts, let t, let code, let msg):
            try c.encode("error.reported", forKey: .type)
            try c.encode(ts, forKey: .timestamp)
            try c.encodeIfPresent(t, forKey: .threadId)
            try c.encode(code, forKey: .code)
            try c.encode(msg, forKey: .message)
        }
    }
}

// ===== UI Actions (iPhone → Host) =====

public enum CodexLinkUIAction: Codable, Sendable, Equatable {
    case submitTurn(threadId: ThreadId, input: String)
    case respondApproval(decision: ApprovalDecision)
    case cancelTurn(threadId: ThreadId)
    case selectProject(projectId: String)

    private enum K: String, CodingKey {
        case type, threadId, input, decision, projectId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "ui.submit_turn":
            self = .submitTurn(
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                input: try c.decode(String.self, forKey: .input)
            )
        case "ui.respond_approval":
            self = .respondApproval(
                decision: try c.decode(ApprovalDecision.self, forKey: .decision)
            )
        case "ui.cancel_turn":
            self = .cancelTurn(threadId: try c.decode(ThreadId.self, forKey: .threadId))
        case "ui.select_project":
            self = .selectProject(projectId: try c.decode(String.self, forKey: .projectId))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c,
                debugDescription: "unknown UI action: \(type)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case .submitTurn(let t, let i):
            try c.encode("ui.submit_turn", forKey: .type)
            try c.encode(t, forKey: .threadId)
            try c.encode(i, forKey: .input)
        case .respondApproval(let d):
            try c.encode("ui.respond_approval", forKey: .type)
            try c.encode(d, forKey: .decision)
        case .cancelTurn(let t):
            try c.encode("ui.cancel_turn", forKey: .type)
            try c.encode(t, forKey: .threadId)
        case .selectProject(let p):
            try c.encode("ui.select_project", forKey: .type)
            try c.encode(p, forKey: .projectId)
        }
    }
}

// ===== Snapshot (replay-on-peer) =====

public struct SessionSnapshotRequest: Codable, Sendable, Equatable {
    public let fromUserId: UserId
    public let fromDeviceId: DeviceId
    public let hostId: HostId
    public let lastSequence: SequenceNumber?

    public init(fromUserId: UserId, fromDeviceId: DeviceId, hostId: HostId, lastSequence: SequenceNumber?) {
        self.fromUserId = fromUserId
        self.fromDeviceId = fromDeviceId
        self.hostId = hostId
        self.lastSequence = lastSequence
    }
}

public struct ThreadProjection: Codable, Sendable, Equatable {
    public let threadId: ThreadId
    public let title: String
    public let status: TurnStatus
    public let transcript: [TranscriptItem]
    public let timeline: [TimelineEntry]
    public let pendingApproval: ApprovalRequest?

    public init(threadId: ThreadId, title: String, status: TurnStatus, transcript: [TranscriptItem], timeline: [TimelineEntry], pendingApproval: ApprovalRequest?) {
        self.threadId = threadId
        self.title = title
        self.status = status
        self.transcript = transcript
        self.timeline = timeline
        self.pendingApproval = pendingApproval
    }
}

public struct CodexLinkProjection: Codable, Sendable, Equatable {
    public let hostId: HostId
    public let capabilities: HostCapabilities
    public let projects: [ProjectDescriptor]
    public let threads: [ThreadProjection]
    public let latestSequence: SequenceNumber
    public let capturedAt: Int

    public init(hostId: HostId, capabilities: HostCapabilities, projects: [ProjectDescriptor], threads: [ThreadProjection], latestSequence: SequenceNumber, capturedAt: Int) {
        self.hostId = hostId
        self.capabilities = capabilities
        self.projects = projects
        self.threads = threads
        self.latestSequence = latestSequence
        self.capturedAt = capturedAt
    }
}

public struct SessionSnapshotResponse: Codable, Sendable, Equatable {
    public let projection: CodexLinkProjection

    public init(projection: CodexLinkProjection) {
        self.projection = projection
    }
}

// ===== Session frame (DataChannel wire) =====

public enum CodexLinkSessionFrame: Codable, Sendable, Equatable {
    case event(CodexLinkEvent)
    case uiAction(CodexLinkUIAction)
    case snapshotRequest(SessionSnapshotRequest)
    case snapshotResponse(SessionSnapshotResponse)
    case ack(SequenceNumber)

    private enum K: String, CodingKey {
        case kind, event, action, request, response, sequence
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "event":
            self = .event(try c.decode(CodexLinkEvent.self, forKey: .event))
        case "ui_action":
            self = .uiAction(try c.decode(CodexLinkUIAction.self, forKey: .action))
        case "snapshot_request":
            self = .snapshotRequest(try c.decode(SessionSnapshotRequest.self, forKey: .request))
        case "snapshot_response":
            self = .snapshotResponse(try c.decode(SessionSnapshotResponse.self, forKey: .response))
        case "ack":
            self = .ack(try c.decode(SequenceNumber.self, forKey: .sequence))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: c,
                debugDescription: "unknown frame kind: \(kind)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case .event(let e):
            try c.encode("event", forKey: .kind)
            try c.encode(e, forKey: .event)
        case .uiAction(let a):
            try c.encode("ui_action", forKey: .kind)
            try c.encode(a, forKey: .action)
        case .snapshotRequest(let r):
            try c.encode("snapshot_request", forKey: .kind)
            try c.encode(r, forKey: .request)
        case .snapshotResponse(let r):
            try c.encode("snapshot_response", forKey: .kind)
            try c.encode(r, forKey: .response)
        case .ack(let s):
            try c.encode("ack", forKey: .kind)
            try c.encode(s, forKey: .sequence)
        }
    }
}
