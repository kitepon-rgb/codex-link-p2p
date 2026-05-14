import XCTest
@testable import CodexLinkIOS

@MainActor
final class SessionProjectionTests: XCTestCase {

    let hostId = HostId("hst_t")
    let projectId = ProjectId("p1")
    let threadId = ThreadId("t1")
    let turnId = TurnId("tn1")

    func testApplyThreadStartedRegistersThread() {
        let p = SessionProjection()
        p.apply(.threadStarted(thread: ThreadRef(id: threadId, projectId: projectId, title: "Hello")))
        XCTAssertEqual(p.state.thread(threadId)?.title, "Hello")
        XCTAssertEqual(p.state.orderedThreadIds(), [threadId])
    }

    func testAssistantDeltaThenFinalAggregatesIntoTranscript() {
        let p = SessionProjection()
        p.apply(.threadStarted(thread: ThreadRef(id: threadId, projectId: projectId, title: "Hi")))
        p.apply(.assistantDelta(threadId: threadId, turnId: turnId, text: "hello "))
        p.apply(.assistantDelta(threadId: threadId, turnId: turnId, text: "world"))
        XCTAssertEqual(p.state.streamingAssistant(for: threadId), "hello world")
        XCTAssertEqual(p.state.transcript(for: threadId).count, 0)

        p.apply(.assistantFinal(
            threadId: threadId,
            turnId: turnId,
            itemId: ItemId("i1"),
            text: "hello world"
        ))
        XCTAssertEqual(p.state.streamingAssistant(for: threadId), "")
        let tr = p.state.transcript(for: threadId)
        XCTAssertEqual(tr.count, 1)
        XCTAssertEqual(tr.first?.text, "hello world")
    }

    func testTimelineStartedThenCompletedSetsStatus() {
        let p = SessionProjection()
        p.apply(.timelineItemStarted(
            threadId: threadId, turnId: turnId, itemId: ItemId("i1"),
            label: "shell", detail: nil
        ))
        let timeline = p.state.timeline(for: threadId)
        XCTAssertEqual(timeline.first?.status, .running)

        p.apply(.timelineItemCompleted(
            threadId: threadId, turnId: turnId, itemId: ItemId("i1"), status: .completed
        ))
        XCTAssertEqual(p.state.timeline(for: threadId).first?.status, .completed)
    }

    func testApprovalRequestedAndResolved() {
        let p = SessionProjection()
        let req = ApprovalRequest(
            id: RequestId("r1"), kind: .commandExecution,
            threadId: threadId, turnId: turnId, itemId: nil,
            title: "rm -rf", detail: "",
            availableDecisions: [.accept, .decline]
        )
        p.apply(.approvalRequested(request: req))
        XCTAssertEqual(p.state.pendingApproval(for: threadId)?.id.rawValue, "r1")

        p.apply(.approvalResolved(requestId: RequestId("r1"), decision: .decline))
        XCTAssertNil(p.state.pendingApproval(for: threadId))
    }

    func testSnapshotResponseSeedsState() {
        let p = SessionProjection()
        let cap = HostCapabilities(hostId: hostId, platform: "macos", codexVersion: "1.0", supportsApprovals: true)
        let thread = ThreadRef(id: threadId, projectId: projectId, title: "T")
        let proj = CodexLinkProjection(
            hostId: hostId,
            account: nil,
            capabilities: cap,
            projects: [ProjectRef(id: projectId, hostId: hostId, name: "P", pathLabel: "/")],
            threads: [
                ThreadProjection(
                    thread: thread, status: .idle, currentTurnId: nil,
                    transcript: [TranscriptItem(id: ItemId("i"), role: .user, text: "hi")],
                    timeline: [], pendingApproval: nil,
                    streamingAssistant: ""
                )
            ],
            latestSequence: 42,
            capturedAt: 1
        )
        p.applySnapshot(proj)
        XCTAssertEqual(p.state.hostId, hostId)
        XCTAssertEqual(p.state.latestSequence, 42)
        XCTAssertEqual(p.state.transcript(for: threadId).first?.text, "hi")
    }

    func testErrorReportedSurfacedAsLatestError() {
        let p = SessionProjection()
        p.apply(.errorReported(scope: "codex", message: "boom"))
        XCTAssertEqual(p.state.latestError, "boom")
    }
}
