// Session protocol types (DataChannel 上のみで流れる).
//
// `packages/protocol/src/session.ts` の Swift mirror. 親リポ (broker 版)
// の iOS と完全同じ field 名 / enum 値で揃え、CodexLink chat UI が当該リポと
// 同じ projection を持てるようにする.

import Foundation

// ===== Host meta =====

public struct HostChatGptAccount: Codable, Equatable, Sendable {
    public let email: String
    public let planType: String?

    public init(email: String, planType: String? = nil) {
        self.email = email
        self.planType = planType
    }
}

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

// ===== Refs =====

public struct ProjectRef: Codable, Sendable, Equatable, Identifiable {
    public let id: ProjectId
    public let hostId: HostId
    public let name: String
    public let pathLabel: String

    public init(id: ProjectId, hostId: HostId, name: String, pathLabel: String) {
        self.id = id
        self.hostId = hostId
        self.name = name
        self.pathLabel = pathLabel
    }
}

public struct ThreadRef: Codable, Sendable, Equatable, Identifiable {
    public let id: ThreadId
    public let projectId: ProjectId
    public let title: String?
    public let updatedAt: String?

    public init(id: ThreadId, projectId: ProjectId, title: String?, updatedAt: String? = nil) {
        self.id = id
        self.projectId = projectId
        self.title = title
        self.updatedAt = updatedAt
    }
}

// ===== Turn status =====

public enum TurnStatus: String, Codable, Equatable, Hashable, Sendable {
    case idle
    case running
    case waitingForApproval = "waiting_for_approval"
    case completed
    case failed
    case canceled
}

// ===== Approval =====

public enum ApprovalKind: String, Codable, Equatable, Sendable {
    case commandExecution = "command_execution"
    case fileChange = "file_change"
    case network
    case userInput = "user_input"
}

public enum ApprovalDecisionKind: String, Codable, Equatable, Sendable {
    case accept
    case acceptForSession = "accept_for_session"
    case decline
    case cancel
}

public struct ApprovalRequest: Codable, Sendable, Equatable, Identifiable {
    public let id: RequestId
    public let kind: ApprovalKind
    public let threadId: ThreadId
    public let turnId: TurnId
    public let itemId: ItemId?
    public let title: String
    public let detail: String
    public let availableDecisions: [ApprovalDecisionKind]

    public init(
        id: RequestId,
        kind: ApprovalKind,
        threadId: ThreadId,
        turnId: TurnId,
        itemId: ItemId? = nil,
        title: String,
        detail: String,
        availableDecisions: [ApprovalDecisionKind]
    ) {
        self.id = id
        self.kind = kind
        self.threadId = threadId
        self.turnId = turnId
        self.itemId = itemId
        self.title = title
        self.detail = detail
        self.availableDecisions = availableDecisions
    }
}

public struct ApprovalDecision: Codable, Sendable, Equatable {
    public let requestId: RequestId
    public let decision: ApprovalDecisionKind

    public init(requestId: RequestId, decision: ApprovalDecisionKind) {
        self.requestId = requestId
        self.decision = decision
    }
}

// ===== Transcript / Timeline =====

public enum TranscriptRole: String, Codable, Equatable, Sendable {
    case user
    case assistant
}

public struct TranscriptItem: Codable, Sendable, Equatable, Identifiable {
    public let id: ItemId
    public let role: TranscriptRole
    public var text: String

    public init(id: ItemId, role: TranscriptRole, text: String) {
        self.id = id
        self.role = role
        self.text = text
    }
}

public enum TimelineItemStatus: String, Codable, Equatable, Sendable {
    case running
    case completed
    case failed
    case declined
}

public struct TimelineEntry: Codable, Sendable, Equatable, Identifiable {
    public var id: ItemId { itemId }
    public let itemId: ItemId
    public let turnId: TurnId
    public var label: String
    public var detail: String?
    public var status: TimelineItemStatus

    public init(itemId: ItemId, turnId: TurnId, label: String, detail: String?, status: TimelineItemStatus) {
        self.itemId = itemId
        self.turnId = turnId
        self.label = label
        self.detail = detail
        self.status = status
    }
}

// ===== Diagnostic =====

public enum DiagnosticSeverity: String, Codable, Equatable, Sendable {
    case info
    case warning
    case error
}

public struct DiagnosticEvent: Codable, Equatable, Sendable {
    public let scope: String
    public let severity: DiagnosticSeverity
    public let message: String

    public init(scope: String, severity: DiagnosticSeverity, message: String) {
        self.scope = scope
        self.severity = severity
        self.message = message
    }
}

// ===== CodexLinkEvent (discriminated union) =====

public enum CodexLinkEvent: Codable, Sendable, Equatable {
    case hostAccountUpdated(hostId: HostId, account: HostChatGptAccount?)
    case hostCapabilitiesUpdated(hostId: HostId, capabilities: HostCapabilities)
    case projectListUpdated(hostId: HostId, projects: [ProjectRef])
    case threadStarted(thread: ThreadRef)
    case turnStatusChanged(threadId: ThreadId, turnId: TurnId, status: TurnStatus)
    case assistantDelta(threadId: ThreadId, turnId: TurnId, text: String)
    case assistantFinal(threadId: ThreadId, turnId: TurnId, itemId: ItemId, text: String)
    case transcriptItemRecorded(threadId: ThreadId, turnId: TurnId, itemId: ItemId, role: TranscriptRole, text: String)
    case timelineItemStarted(threadId: ThreadId, turnId: TurnId, itemId: ItemId, label: String, detail: String?)
    case timelineItemCompleted(threadId: ThreadId, turnId: TurnId, itemId: ItemId, status: TimelineItemStatus)
    case approvalRequested(request: ApprovalRequest)
    case approvalResolved(requestId: RequestId, decision: ApprovalDecisionKind?)
    case rateLimitUpdated(userId: UserId, usedPercent: Double?)
    case diagnosticReported(diagnostic: DiagnosticEvent)
    case errorReported(scope: String, message: String)

    private enum CodingKeys: String, CodingKey {
        case type, hostId, account, capabilities, projects, thread
        case threadId, turnId, itemId, role, text, label, detail, status
        case request, requestId, decision
        case userId, usedPercent
        case diagnostic, scope, message
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .hostAccountUpdated(let hostId, let account):
            try c.encode("host.account.updated", forKey: .type)
            try c.encode(hostId, forKey: .hostId)
            try c.encode(account, forKey: .account)
        case .hostCapabilitiesUpdated(let hostId, let capabilities):
            try c.encode("host.capabilities.updated", forKey: .type)
            try c.encode(hostId, forKey: .hostId)
            try c.encode(capabilities, forKey: .capabilities)
        case .projectListUpdated(let hostId, let projects):
            try c.encode("project.list.updated", forKey: .type)
            try c.encode(hostId, forKey: .hostId)
            try c.encode(projects, forKey: .projects)
        case .threadStarted(let thread):
            try c.encode("thread.started", forKey: .type)
            try c.encode(thread, forKey: .thread)
        case .turnStatusChanged(let threadId, let turnId, let status):
            try c.encode("turn.status.changed", forKey: .type)
            try c.encode(threadId, forKey: .threadId)
            try c.encode(turnId, forKey: .turnId)
            try c.encode(status, forKey: .status)
        case .assistantDelta(let threadId, let turnId, let text):
            try c.encode("assistant.delta", forKey: .type)
            try c.encode(threadId, forKey: .threadId)
            try c.encode(turnId, forKey: .turnId)
            try c.encode(text, forKey: .text)
        case .assistantFinal(let threadId, let turnId, let itemId, let text):
            try c.encode("assistant.final", forKey: .type)
            try c.encode(threadId, forKey: .threadId)
            try c.encode(turnId, forKey: .turnId)
            try c.encode(itemId, forKey: .itemId)
            try c.encode(text, forKey: .text)
        case .transcriptItemRecorded(let threadId, let turnId, let itemId, let role, let text):
            try c.encode("transcript.item.recorded", forKey: .type)
            try c.encode(threadId, forKey: .threadId)
            try c.encode(turnId, forKey: .turnId)
            try c.encode(itemId, forKey: .itemId)
            try c.encode(role, forKey: .role)
            try c.encode(text, forKey: .text)
        case .timelineItemStarted(let threadId, let turnId, let itemId, let label, let detail):
            try c.encode("timeline.item.started", forKey: .type)
            try c.encode(threadId, forKey: .threadId)
            try c.encode(turnId, forKey: .turnId)
            try c.encode(itemId, forKey: .itemId)
            try c.encode(label, forKey: .label)
            try c.encodeIfPresent(detail, forKey: .detail)
        case .timelineItemCompleted(let threadId, let turnId, let itemId, let status):
            try c.encode("timeline.item.completed", forKey: .type)
            try c.encode(threadId, forKey: .threadId)
            try c.encode(turnId, forKey: .turnId)
            try c.encode(itemId, forKey: .itemId)
            try c.encode(status, forKey: .status)
        case .approvalRequested(let request):
            try c.encode("approval.requested", forKey: .type)
            try c.encode(request, forKey: .request)
        case .approvalResolved(let requestId, let decision):
            try c.encode("approval.resolved", forKey: .type)
            try c.encode(requestId, forKey: .requestId)
            try c.encodeIfPresent(decision, forKey: .decision)
        case .rateLimitUpdated(let userId, let usedPercent):
            try c.encode("rate_limit.updated", forKey: .type)
            try c.encode(userId, forKey: .userId)
            try c.encodeIfPresent(usedPercent, forKey: .usedPercent)
        case .diagnosticReported(let diagnostic):
            try c.encode("diagnostic.reported", forKey: .type)
            try c.encode(diagnostic, forKey: .diagnostic)
        case .errorReported(let scope, let message):
            try c.encode("error.reported", forKey: .type)
            try c.encode(scope, forKey: .scope)
            try c.encode(message, forKey: .message)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "host.account.updated":
            self = .hostAccountUpdated(
                hostId: try c.decode(HostId.self, forKey: .hostId),
                account: try c.decodeIfPresent(HostChatGptAccount.self, forKey: .account)
            )
        case "host.capabilities.updated":
            self = .hostCapabilitiesUpdated(
                hostId: try c.decode(HostId.self, forKey: .hostId),
                capabilities: try c.decode(HostCapabilities.self, forKey: .capabilities)
            )
        case "project.list.updated":
            self = .projectListUpdated(
                hostId: try c.decode(HostId.self, forKey: .hostId),
                projects: try c.decode([ProjectRef].self, forKey: .projects)
            )
        case "thread.started":
            self = .threadStarted(thread: try c.decode(ThreadRef.self, forKey: .thread))
        case "turn.status.changed":
            self = .turnStatusChanged(
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                turnId: try c.decode(TurnId.self, forKey: .turnId),
                status: try c.decode(TurnStatus.self, forKey: .status)
            )
        case "assistant.delta":
            self = .assistantDelta(
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                turnId: try c.decode(TurnId.self, forKey: .turnId),
                text: try c.decode(String.self, forKey: .text)
            )
        case "assistant.final":
            self = .assistantFinal(
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                turnId: try c.decode(TurnId.self, forKey: .turnId),
                itemId: try c.decode(ItemId.self, forKey: .itemId),
                text: try c.decode(String.self, forKey: .text)
            )
        case "transcript.item.recorded":
            self = .transcriptItemRecorded(
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                turnId: try c.decode(TurnId.self, forKey: .turnId),
                itemId: try c.decode(ItemId.self, forKey: .itemId),
                role: try c.decode(TranscriptRole.self, forKey: .role),
                text: try c.decode(String.self, forKey: .text)
            )
        case "timeline.item.started":
            self = .timelineItemStarted(
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                turnId: try c.decode(TurnId.self, forKey: .turnId),
                itemId: try c.decode(ItemId.self, forKey: .itemId),
                label: try c.decode(String.self, forKey: .label),
                detail: try c.decodeIfPresent(String.self, forKey: .detail)
            )
        case "timeline.item.completed":
            self = .timelineItemCompleted(
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                turnId: try c.decode(TurnId.self, forKey: .turnId),
                itemId: try c.decode(ItemId.self, forKey: .itemId),
                status: try c.decode(TimelineItemStatus.self, forKey: .status)
            )
        case "approval.requested":
            self = .approvalRequested(request: try c.decode(ApprovalRequest.self, forKey: .request))
        case "approval.resolved":
            self = .approvalResolved(
                requestId: try c.decode(RequestId.self, forKey: .requestId),
                decision: try c.decodeIfPresent(ApprovalDecisionKind.self, forKey: .decision)
            )
        case "rate_limit.updated":
            self = .rateLimitUpdated(
                userId: try c.decode(UserId.self, forKey: .userId),
                usedPercent: try c.decodeIfPresent(Double.self, forKey: .usedPercent)
            )
        case "diagnostic.reported":
            self = .diagnosticReported(diagnostic: try c.decode(DiagnosticEvent.self, forKey: .diagnostic))
        case "error.reported":
            self = .errorReported(
                scope: try c.decode(String.self, forKey: .scope),
                message: try c.decode(String.self, forKey: .message)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c, debugDescription: "Unknown CodexLinkEvent type: \(type)"
            )
        }
    }
}

// ===== UI Action (iPhone → Host) =====

public enum CodexLinkUIAction: Codable, Sendable, Equatable {
    case submitTurn(projectId: ProjectId, threadId: ThreadId?, input: String)
    case respondApproval(decision: ApprovalDecision)
    case cancelTurn(threadId: ThreadId, turnId: TurnId)
    case selectProject(projectId: ProjectId)
    case resumeThread(threadId: ThreadId)

    private enum CodingKeys: String, CodingKey {
        case type
        case projectId, threadId, turnId, input, decision
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .submitTurn(let projectId, let threadId, let input):
            try c.encode("ui.submit_turn", forKey: .type)
            try c.encode(projectId, forKey: .projectId)
            try c.encodeIfPresent(threadId, forKey: .threadId)
            try c.encode(input, forKey: .input)
        case .respondApproval(let decision):
            try c.encode("ui.respond_approval", forKey: .type)
            try c.encode(decision, forKey: .decision)
        case .cancelTurn(let threadId, let turnId):
            try c.encode("ui.cancel_turn", forKey: .type)
            try c.encode(threadId, forKey: .threadId)
            try c.encode(turnId, forKey: .turnId)
        case .selectProject(let projectId):
            try c.encode("ui.select_project", forKey: .type)
            try c.encode(projectId, forKey: .projectId)
        case .resumeThread(let threadId):
            try c.encode("ui.resume_thread", forKey: .type)
            try c.encode(threadId, forKey: .threadId)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "ui.submit_turn":
            self = .submitTurn(
                projectId: try c.decode(ProjectId.self, forKey: .projectId),
                threadId: try c.decodeIfPresent(ThreadId.self, forKey: .threadId),
                input: try c.decode(String.self, forKey: .input)
            )
        case "ui.respond_approval":
            self = .respondApproval(decision: try c.decode(ApprovalDecision.self, forKey: .decision))
        case "ui.cancel_turn":
            self = .cancelTurn(
                threadId: try c.decode(ThreadId.self, forKey: .threadId),
                turnId: try c.decode(TurnId.self, forKey: .turnId)
            )
        case "ui.select_project":
            self = .selectProject(projectId: try c.decode(ProjectId.self, forKey: .projectId))
        case "ui.resume_thread":
            self = .resumeThread(threadId: try c.decode(ThreadId.self, forKey: .threadId))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c, debugDescription: "Unknown CodexLinkUIAction type: \(type)"
            )
        }
    }
}

// ===== Snapshot =====

public struct SessionSnapshotRequest: Codable, Sendable, Equatable {
    public let fromUserId: UserId
    public let fromDeviceId: DeviceId
    public let hostId: HostId
    public let lastSequence: Int?

    public init(fromUserId: UserId, fromDeviceId: DeviceId, hostId: HostId, lastSequence: Int?) {
        self.fromUserId = fromUserId
        self.fromDeviceId = fromDeviceId
        self.hostId = hostId
        self.lastSequence = lastSequence
    }
}

public struct ThreadProjection: Codable, Sendable, Equatable {
    public let thread: ThreadRef
    public let status: TurnStatus
    public let currentTurnId: TurnId?
    public let transcript: [TranscriptItem]
    public let timeline: [TimelineEntry]
    public let pendingApproval: ApprovalRequest?
    public let streamingAssistant: String

    public init(
        thread: ThreadRef,
        status: TurnStatus,
        currentTurnId: TurnId?,
        transcript: [TranscriptItem],
        timeline: [TimelineEntry],
        pendingApproval: ApprovalRequest?,
        streamingAssistant: String
    ) {
        self.thread = thread
        self.status = status
        self.currentTurnId = currentTurnId
        self.transcript = transcript
        self.timeline = timeline
        self.pendingApproval = pendingApproval
        self.streamingAssistant = streamingAssistant
    }
}

public struct CodexLinkProjection: Codable, Sendable, Equatable {
    public let hostId: HostId
    public let account: HostChatGptAccount?
    public let capabilities: HostCapabilities
    public let projects: [ProjectRef]
    public let threads: [ThreadProjection]
    public let latestSequence: Int
    public let capturedAt: Int

    public init(
        hostId: HostId,
        account: HostChatGptAccount?,
        capabilities: HostCapabilities,
        projects: [ProjectRef],
        threads: [ThreadProjection],
        latestSequence: Int,
        capturedAt: Int
    ) {
        self.hostId = hostId
        self.account = account
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

// ===== Live Activity =====

public struct LiveActivityState: Codable, Equatable, Sendable {
    public var hostName: String
    public var projectName: String
    public var status: TurnStatus
    public var latestText: String?
    public var approvalRequired: Bool

    public init(hostName: String, projectName: String, status: TurnStatus, latestText: String?, approvalRequired: Bool) {
        self.hostName = hostName
        self.projectName = projectName
        self.status = status
        self.latestText = latestText
        self.approvalRequired = approvalRequired
    }
}

// ===== Session frame (DataChannel wire) =====

public enum CodexLinkSessionFrame: Codable, Sendable {
    case event(sequence: Int, timestamp: Int, event: CodexLinkEvent)
    case uiAction(CodexLinkUIAction)
    case snapshotRequest(SessionSnapshotRequest)
    case snapshotResponse(SessionSnapshotResponse)
    case ack(sequence: Int)

    private enum CodingKeys: String, CodingKey {
        case kind, sequence, timestamp, event, action, request, response
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .event(let sequence, let timestamp, let event):
            try c.encode("event", forKey: .kind)
            try c.encode(sequence, forKey: .sequence)
            try c.encode(timestamp, forKey: .timestamp)
            try c.encode(event, forKey: .event)
        case .uiAction(let action):
            try c.encode("ui_action", forKey: .kind)
            try c.encode(action, forKey: .action)
        case .snapshotRequest(let r):
            try c.encode("snapshot_request", forKey: .kind)
            try c.encode(r, forKey: .request)
        case .snapshotResponse(let r):
            try c.encode("snapshot_response", forKey: .kind)
            try c.encode(r, forKey: .response)
        case .ack(let sequence):
            try c.encode("ack", forKey: .kind)
            try c.encode(sequence, forKey: .sequence)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "event":
            self = .event(
                sequence: try c.decode(Int.self, forKey: .sequence),
                timestamp: try c.decode(Int.self, forKey: .timestamp),
                event: try c.decode(CodexLinkEvent.self, forKey: .event)
            )
        case "ui_action":
            self = .uiAction(try c.decode(CodexLinkUIAction.self, forKey: .action))
        case "snapshot_request":
            self = .snapshotRequest(try c.decode(SessionSnapshotRequest.self, forKey: .request))
        case "snapshot_response":
            self = .snapshotResponse(try c.decode(SessionSnapshotResponse.self, forKey: .response))
        case "ack":
            self = .ack(sequence: try c.decode(Int.self, forKey: .sequence))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: c, debugDescription: "Unknown CodexLinkSessionFrame kind: \(kind)"
            )
        }
    }
}
