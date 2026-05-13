import XCTest
@testable import CodexLinkIOS

@MainActor
final class SessionProjectionTests: XCTestCase {

    let hostId = HostId("hst_t")
    let threadId = ThreadId("t1")

    func testApplyThreadStartedRegistersThread() {
        let p = SessionProjection()
        p.apply(.event(.threadStarted(
            seq: SequenceNumber(1), ts: 1, threadId: threadId, projectId: "p", title: "Hello"
        )))
        XCTAssertEqual(p.threads[threadId]?.title, "Hello")
        XCTAssertEqual(p.orderedThreadIds, [threadId])
        XCTAssertEqual(p.latestSequence, SequenceNumber(1))
    }

    func testAssistantDeltaThenFinalAggregatesIntoTranscript() {
        let p = SessionProjection()
        p.apply(.event(.threadStarted(seq: SequenceNumber(1), ts: 1, threadId: threadId, projectId: "p", title: "Hi")))
        p.apply(.event(.assistantDelta(seq: SequenceNumber(2), ts: 2, threadId: threadId, delta: "hello ")))
        p.apply(.event(.assistantDelta(seq: SequenceNumber(3), ts: 3, threadId: threadId, delta: "world")))
        XCTAssertEqual(p.threads[threadId]?.streamingAssistant, "hello world")
        XCTAssertEqual(p.threads[threadId]?.transcript.count, 0)

        p.apply(.event(.assistantFinal(seq: SequenceNumber(4), ts: 4, threadId: threadId, text: "hello world")))
        XCTAssertEqual(p.threads[threadId]?.streamingAssistant, "")
        XCTAssertEqual(p.threads[threadId]?.transcript.count, 1)
        XCTAssertEqual(p.threads[threadId]?.transcript.first?.content, "hello world")
    }

    func testTimelineStartedThenCompletedSetsOutcome() {
        let p = SessionProjection()
        p.apply(.event(.timelineItemStarted(
            seq: SequenceNumber(1), ts: 1, threadId: threadId,
            itemId: "i1", kind: .toolCall, label: "shell"
        )))
        XCTAssertEqual(p.threads[threadId]?.timeline.first?.outcome, nil)

        p.apply(.event(.timelineItemCompleted(
            seq: SequenceNumber(2), ts: 2, threadId: threadId, itemId: "i1", outcome: .success
        )))
        XCTAssertEqual(p.threads[threadId]?.timeline.first?.outcome, .success)
    }

    func testApprovalRequestedAndResolved() {
        let p = SessionProjection()
        let req = ApprovalRequest(
            requestId: RequestId("r1"), threadId: threadId,
            summary: "rm -rf", kind: .command, detail: ""
        )
        p.apply(.event(.approvalRequested(seq: SequenceNumber(1), ts: 1, request: req)))
        XCTAssertEqual(p.threads[threadId]?.pendingApproval?.requestId.rawValue, "r1")
        p.apply(.event(.approvalResolved(
            seq: SequenceNumber(2), ts: 2, threadId: threadId,
            decision: ApprovalDecision(requestId: RequestId("r1"), approved: false)
        )))
        XCTAssertNil(p.threads[threadId]?.pendingApproval)
    }

    func testSnapshotResponseSeedsState() {
        let p = SessionProjection()
        let cap = HostCapabilities(hostId: hostId, platform: "macos", codexVersion: "1.0", supportsApprovals: true)
        let proj = CodexLinkProjection(
            hostId: hostId,
            capabilities: cap,
            projects: [ProjectDescriptor(id: "p", displayName: "P", path: "/")],
            threads: [
                ThreadProjection(
                    threadId: threadId, title: "T", status: .idle,
                    transcript: [TranscriptItem(id: "i", role: .user, content: "hi")],
                    timeline: [], pendingApproval: nil
                )
            ],
            latestSequence: SequenceNumber(42),
            capturedAt: 1
        )
        p.apply(.snapshotResponse(SessionSnapshotResponse(projection: proj)))
        XCTAssertEqual(p.hostId, hostId)
        XCTAssertEqual(p.latestSequence, SequenceNumber(42))
        XCTAssertEqual(p.threads[threadId]?.transcript.first?.content, "hi")
    }

    func testErrorReportedSurfacedAsLastError() {
        let p = SessionProjection()
        p.apply(.event(.errorReported(
            seq: SequenceNumber(1), ts: 1, threadId: threadId, code: "boom", message: "msg"
        )))
        XCTAssertEqual(p.lastError?.code, "boom")
        XCTAssertEqual(p.lastError?.threadId, threadId)
    }

    func testIgnoresHostBoundFrames() {
        let p = SessionProjection()
        // 入力方向ではない (iPhone は ui_action / snapshot_request を送る側). 受け取ってもクラッシュしないことだけ確認.
        p.apply(.uiAction(.cancelTurn(threadId: threadId)))
        p.apply(.ack(SequenceNumber(1)))
        p.apply(.snapshotRequest(SessionSnapshotRequest(
            fromUserId: UserId("u"), fromDeviceId: DeviceId("d"), hostId: hostId, lastSequence: nil
        )))
        XCTAssertTrue(p.threads.isEmpty)
    }
}
