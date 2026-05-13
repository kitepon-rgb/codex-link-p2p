// PeerManager の in-process integration test.
//
// 2 つの PeerManager を立てて、片方を offerer、片方を answerer (本番の Mac
// Host) として直接 signal envelope を交換し、DataChannel が open するまで
// 確認する. Relay は通さない (peer.ts の単体検証).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  asDeviceId,
  asHostId,
  asUserId,
  type HostSignalReply,
  type RtcSignal,
} from "@codex-link/protocol/rendezvous";
import {
  asSequenceNumber,
  asThreadId,
  type AssistantDeltaEvent,
  type CodexLinkSessionFrame,
} from "@codex-link/protocol/session";
import { PeerConnection as RawPeer } from "node-datachannel";

import { DATA_CHANNEL_LABEL, PeerManager } from "../src/peer.js";

const hostId = asHostId("hst_test");
const userId = asUserId("usr_phone");
const deviceId = asDeviceId("dev_phone");

let peerManager: PeerManager | null = null;
let rawClient: RawPeer | null = null;

const waitFor = (cond: () => boolean, timeoutMs = 5_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor timed out (${timeoutMs}ms)`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });

afterEach(async () => {
  try {
    peerManager?.closeAll();
  } catch {
    // ignore
  }
  try {
    rawClient?.close();
  } catch {
    // ignore
  }
  peerManager = null;
  rawClient = null;
});

beforeEach(() => {
  // 何もしない. node-datachannel は自動 init される.
});

describe("PeerManager (in-process answerer)", () => {
  it("establishes a DataChannel with an external offerer in-process", async () => {
    const iceServers = ["stun:stun.l.google.com:19302"];
    const incomingFrames: CodexLinkSessionFrame[] = [];
    let dcOpened = false;

    // Host 側 (PeerManager) と擬似 client (生の RawPeer) を 1 process 内で動かす.
    const queuedFromHost: HostSignalReply[] = [];
    peerManager = new PeerManager(
      { hostId, iceServers },
      {
        onLocalSignal: (_key, reply) => {
          queuedFromHost.push(reply);
        },
        onDataChannelOpen: () => {
          dcOpened = true;
        },
        onFrame: (_key, frame) => {
          incomingFrames.push(frame);
        },
      },
    );

    // client 側: 生の RawPeer を offerer として作る.
    rawClient = new RawPeer("test-client", { iceServers: [...iceServers] });
    const clientCandidates: Array<{ candidate: string; mid: string }> = [];
    let clientOfferSdp: string | null = null;
    let clientGotAnswer = false;
    let clientDc: ReturnType<typeof rawClient.createDataChannel> | null = null;

    rawClient.onLocalDescription((sdp, type) => {
      if (type === "offer") clientOfferSdp = sdp;
    });
    rawClient.onLocalCandidate((candidate, mid) => {
      clientCandidates.push({ candidate, mid });
    });

    // client が DataChannel を作って offer を出す.
    clientDc = rawClient.createDataChannel(DATA_CHANNEL_LABEL, {});

    await waitFor(() => clientOfferSdp !== null, 2_000);

    const offerSdpVal = clientOfferSdp;
    if (offerSdpVal === null) throw new Error("offer not generated");
    // client offer を host 側に "signal.from_client" 相当として送る.
    const offerSignal: RtcSignal = {
      kind: "offer",
      sdpBase64: Buffer.from(offerSdpVal, "utf8").toString("base64"),
    };
    peerManager.applyClientSignal({ userId, deviceId }, offerSignal);

    // 初期 candidate を流し込む (ICE trickle).
    for (const c of clientCandidates) {
      peerManager.applyClientSignal(
        { userId, deviceId },
        {
          kind: "ice",
          candidateBase64: Buffer.from(c.candidate, "utf8").toString("base64"),
          sdpMid: c.mid,
          sdpMLineIndex: null,
        },
      );
    }
    // 以降の candidate もリアルタイムに流す.
    rawClient.onLocalCandidate((candidate, mid) => {
      peerManager?.applyClientSignal(
        { userId, deviceId },
        {
          kind: "ice",
          candidateBase64: Buffer.from(candidate, "utf8").toString("base64"),
          sdpMid: mid,
          sdpMLineIndex: null,
        },
      );
    });

    // host が return する answer を待つ.
    await waitFor(() => queuedFromHost.some((r) => r.signal.kind === "answer"), 2_000);
    const answerReply = queuedFromHost.find((r) => r.signal.kind === "answer");
    if (
      answerReply === undefined ||
      answerReply.signal.kind !== "answer"
    ) {
      throw new Error("no answer reply");
    }
    const answerSdp = Buffer.from(
      answerReply.signal.sdpBase64,
      "base64",
    ).toString("utf8");
    rawClient.setRemoteDescription(answerSdp, "answer");
    clientGotAnswer = true;

    // host が送る ICE candidate を client へ流し込む.
    let processedReplies = queuedFromHost.length;
    const drainHostReplies = (): void => {
      for (let i = processedReplies; i < queuedFromHost.length; i++) {
        const r = queuedFromHost[i];
        if (r === undefined) continue;
        if (r.signal.kind === "ice") {
          const cand = Buffer.from(
            r.signal.candidateBase64,
            "base64",
          ).toString("utf8");
          try {
            rawClient?.addRemoteCandidate(cand, r.signal.sdpMid ?? "0");
          } catch {
            // ignore
          }
        }
      }
      processedReplies = queuedFromHost.length;
    };
    // host 側からの local candidate を反映するための新しい onLocalSignal は
    // ハンドラ差し替えが必要. PeerManager の handlers は constructor で固定して
    // いるが、queuedFromHost が成長するので、定期的に drain すれば十分.
    const drainTimer = setInterval(drainHostReplies, 50);

    // DataChannel が両側で open するまで待つ.
    let clientDcOpened = false;
    clientDc.onOpen(() => {
      clientDcOpened = true;
    });

    await waitFor(() => dcOpened && clientDcOpened, 8_000);
    clearInterval(drainTimer);

    expect(clientGotAnswer).toBe(true);

    // host → client メッセージング.
    const event: AssistantDeltaEvent = {
      type: "assistant.delta",
      sequence: asSequenceNumber(1),
      timestamp: Date.now(),
      threadId: asThreadId("th-1"),
      delta: "hello iPhone",
    };
    const sent = peerManager.sendFrame(
      { userId, deviceId },
      { kind: "event", event },
    );
    expect(sent).toBe(true);

    // client → host メッセージング.
    clientDc.sendMessage(
      JSON.stringify({
        kind: "ack",
        sequence: asSequenceNumber(1),
      } as CodexLinkSessionFrame),
    );

    await waitFor(() => incomingFrames.length >= 1, 2_000);
    expect(incomingFrames[0]?.kind).toBe("ack");

    expect(peerManager.hasPeer({ userId, deviceId })).toBe(true);

    const stats = peerManager.stats({ userId, deviceId });
    expect(stats).not.toBeNull();
    expect(stats?.state).toBe("connected");
  }, 15_000);

  it("returns null stats for unknown peer and broadcast 0", () => {
    peerManager = new PeerManager(
      { hostId, iceServers: [] },
      { onLocalSignal: () => {} },
    );
    expect(peerManager.stats({ userId, deviceId })).toBeNull();
    expect(peerManager.hasPeer({ userId, deviceId })).toBe(false);
    expect(peerManager.broadcastFrame({ kind: "ack", sequence: asSequenceNumber(0) })).toBe(0);
  });
});
