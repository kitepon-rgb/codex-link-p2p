// Phase 6 E2E test — Relay + Mac Host + 生 WebRTC iPhone offerer を 1 process
// 内で結線して、CodexLinkEvent が iPhone 役の DataChannel に届くまでの全経路を
// 確認する.
//
// 構成:
//   [iPhone 役 (生 PeerConnection)]
//        ↑ DataChannel (CodexLinkSessionFrame)
//        ↓
//        ↑ WSS signaling (offer/answer/ice via Relay)
//        ↓
//   [Relay HTTP+WS server]
//        ↑↓
//   [Mac Host SignalingClient → PeerManager → SessionManager → NullCodexClient]
//
// Mac Host が emit する codex event が iPhone 役の DataChannel まで届けば成功.
// このテストが通ることが MVP の "コードが動く" の最低保証.

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import WS from "ws";
import { PeerConnection as RawPeer } from "node-datachannel";

import {
  asUserId,
  asDeviceId,
  asHostId,
  type WsInbound,
  type WsOutbound,
} from "@codex-link/protocol/rendezvous";
import {
  asSequenceNumber,
  asThreadId,
  type CodexLinkSessionFrame,
} from "@codex-link/protocol/session";
import {
  createRelayServer,
  createRelayState,
  loadConfig,
  type StartedServer,
  startRelayServer,
} from "@codex-link/relay";

import { NullCodexClient } from "../src/codex.js";
import { PeerManager } from "../src/peer.js";
import { SessionManager } from "../src/session.js";
import { SignalingClient } from "../src/signaling-client.js";
import { DATA_CHANNEL_LABEL } from "../src/peer.js";

const env = {
  TURN_SHARED_SECRET: "test-turn-e2e",
  CODEX_LINK_HOST_BOOTSTRAP_TOKEN: "test-bootstrap-e2e",
};

let relay: StartedServer;
let baseUrl: string;

const post = async (path: string, body: unknown, init?: RequestInit) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });

const waitFor = (cond: () => boolean, timeoutMs = 5_000, label = "cond"): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitFor(${label}) timed out (${timeoutMs}ms)`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });

beforeEach(async () => {
  const state = createRelayState();
  const config = loadConfig({ env });
  const created = createRelayServer({ state, config, now: () => Date.now() });
  relay = await startRelayServer(created, "127.0.0.1", 0);
  baseUrl = `http://127.0.0.1:${relay.port}`;
});

afterEach(async () => {
  await relay.close();
});

describe("E2E: Relay + Mac Host + raw iPhone offerer", () => {
  it("delivers a Codex event from Mac Host's NullCodexClient to the iPhone DataChannel", async () => {
    // 1) Mac Host を bootstrap.
    const bootR = await post("/api/host-bootstrap", {
      bootstrapToken: env.CODEX_LINK_HOST_BOOTSTRAP_TOKEN,
      hostDisplayName: "kite Mac",
      hostPlatform: "macos",
      devicePlatform: "macos",
    });
    expect(bootR.status).toBe(201);
    const boot = (await bootR.json()) as {
      userId: string;
      deviceId: string;
      sessionToken: string;
      host: { id: string };
    };
    const hostId = asHostId(boot.host.id);
    const hostSessionToken = boot.sessionToken;

    // 2) Mac Host process 内で SignalingClient + PeerManager + SessionManager
    //    を立ち上げる.
    const codex = new NullCodexClient();
    await codex.start();

    const peerManager = new PeerManager(
      { hostId, iceServers: ["stun:stun.l.google.com:19302"] },
      {
        onLocalSignal: (key, reply) => {
          // Host -> iPhone: signaling 経由で送る.
          hostSignaling.sendSignalToClient(reply);
          void key;
        },
        onFrame: (key, frame) => session.handlePeerFrame(key, frame),
      },
    );

    const session = new SessionManager({
      hostId,
      hostCapabilities: {
        hostId,
        platform: "macos",
        codexVersion: "test",
        supportsApprovals: true,
      },
      codex,
      peers: peerManager,
    });
    session.start();

    let issuedCode: string | null = null;
    const hostSignaling = new SignalingClient({
      relayUrl: baseUrl,
      sessionToken: hostSessionToken,
      handlers: {
        onWelcome: () => {
          hostSignaling.announce(hostId);
          hostSignaling.createPairingCode(hostId);
        },
        onSignalFromClient: (msg) => {
          const env = msg.envelope;
          peerManager.applyClientSignal(
            { userId: env.fromUserId, deviceId: env.fromDeviceId },
            env.signal,
          );
        },
        onPairingCodeIssued: (msg) => {
          issuedCode = msg.code;
        },
      },
    });
    hostSignaling.start();
    await waitFor(() => issuedCode !== null, 2_000, "host pairing code");

    // 3) iPhone 役: HTTP で device 登録 → pair で HostAccess を得る.
    const regR = await post("/api/device-session/register", {
      displayName: "kite iPhone",
      platform: "ios",
    });
    const reg = (await regR.json()) as {
      userId: string;
      deviceId: string;
      sessionToken: string;
    };
    const iphoneUserId = asUserId(reg.userId);
    const iphoneDeviceId = asDeviceId(reg.deviceId);

    const pairR = await post(
      "/api/device-session/pair",
      { pairingCode: issuedCode },
      { headers: { authorization: `Bearer ${reg.sessionToken}` } },
    );
    expect(pairR.status).toBe(200);

    // 4) iPhone 役 WS を直接張る (Swift SignalingClient と同じ wire を生で話す).
    const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/relay";
    const iphoneWs = new WS(wsUrl, {
      headers: { authorization: `Bearer ${reg.sessionToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      iphoneWs.once("open", () => resolve());
      iphoneWs.once("error", reject);
    });

    const iphoneSend = (msg: WsInbound): void => {
      iphoneWs.send(JSON.stringify(msg));
    };

    // 5) 生 PeerConnection を offerer として立てる.
    const rawClient = new RawPeer("iphone", {
      iceServers: ["stun:stun.l.google.com:19302"],
    });
    let dcOpened = false;
    const incomingFrames: CodexLinkSessionFrame[] = [];

    // 受信 dispatcher: 生 WS → applyClientSignal 相当の処理を host 側で
    // 自動的に進める. iPhone 側は signal.from_host (answer / ICE) を peer に
    // 流す.
    iphoneWs.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString();
      let msg: WsOutbound;
      try {
        msg = JSON.parse(text) as WsOutbound;
      } catch {
        return;
      }
      if (msg.type === "signal.from_host") {
        const s = msg.reply.signal;
        if (s.kind === "answer") {
          const sdp = Buffer.from(s.sdpBase64, "base64").toString("utf8");
          rawClient.setRemoteDescription(sdp, "answer");
        } else if (s.kind === "ice") {
          const cand = Buffer.from(s.candidateBase64, "base64").toString("utf8");
          try {
            rawClient.addRemoteCandidate(cand, s.sdpMid ?? "0");
          } catch {
            // ignore late candidates
          }
        }
      }
    });

    rawClient.onLocalDescription((sdp, type) => {
      if (type === "offer") {
        iphoneSend({
          type: "signal.to_host",
          hostId,
          signal: {
            kind: "offer",
            sdpBase64: Buffer.from(sdp, "utf8").toString("base64"),
          },
          sentAt: Date.now(),
        });
      }
    });
    rawClient.onLocalCandidate((candidate, mid) => {
      iphoneSend({
        type: "signal.to_host",
        hostId,
        signal: {
          kind: "ice",
          candidateBase64: Buffer.from(candidate, "utf8").toString("base64"),
          sdpMid: mid,
          sdpMLineIndex: null,
        },
        sentAt: Date.now(),
      });
    });

    const clientDc = rawClient.createDataChannel(DATA_CHANNEL_LABEL, {});
    clientDc.onOpen(() => {
      dcOpened = true;
    });
    clientDc.onMessage((m: string | ArrayBuffer | Buffer) => {
      const text =
        typeof m === "string"
          ? m
          : Buffer.isBuffer(m)
            ? m.toString("utf8")
            : Buffer.from(m).toString("utf8");
      try {
        incomingFrames.push(JSON.parse(text) as CodexLinkSessionFrame);
      } catch {
        // ignore
      }
    });

    // 6) DataChannel が両側で open するまで待つ.
    await waitFor(() => dcOpened, 8_000, "iphone dc open");

    // 7) Mac Host 側で Codex event を 1 件 emit → broadcast.
    codex.emit({
      type: "thread_started",
      threadId: "t1",
      data: { projectId: "p", title: "Hi" },
    });
    codex.emit({
      type: "assistant_message_delta",
      threadId: "t1",
      data: { delta: "hello from codex" },
    });

    // 8) iPhone 役 が CodexLinkSessionFrame を受け取る.
    await waitFor(
      () =>
        incomingFrames.some(
          (f) =>
            f.kind === "event" &&
            f.event.type === "assistant.delta" &&
            f.event.delta === "hello from codex",
        ),
      4_000,
      "iphone receives assistant.delta",
    );

    // 9) 逆方向: iPhone → DataChannel に ui_action を送る → SessionManager が
    //    NullCodexClient に command を渡す.
    const submitFrame: CodexLinkSessionFrame = {
      kind: "ui_action",
      action: {
        type: "ui.submit_turn",
        threadId: asThreadId("t1"),
        input: "ping from iphone",
      },
    };
    clientDc.sendMessage(JSON.stringify(submitFrame));

    await waitFor(
      () => codex.commandsSent().some((c) => c.type === "user_turn"),
      4_000,
      "codex receives user_turn command",
    );
    const cmd = codex.commandsSent().find((c) => c.type === "user_turn");
    expect((cmd?.data as Record<string, unknown> | undefined)?.["input"]).toBe(
      "ping from iphone",
    );

    // 10) Snapshot request → response も通ること.
    const snapReq: CodexLinkSessionFrame = {
      kind: "snapshot_request",
      request: {
        fromUserId: iphoneUserId,
        fromDeviceId: iphoneDeviceId,
        hostId,
        lastSequence: asSequenceNumber(0),
      },
    };
    clientDc.sendMessage(JSON.stringify(snapReq));
    await waitFor(
      () => incomingFrames.some((f) => f.kind === "snapshot_response"),
      4_000,
      "iphone receives snapshot_response",
    );
    const snapResp = incomingFrames.find((f) => f.kind === "snapshot_response");
    if (snapResp?.kind === "snapshot_response") {
      expect(snapResp.response.projection.threads.length).toBe(1);
    }

    // Cleanup.
    clientDc.close();
    rawClient.close();
    iphoneWs.close();
    peerManager.closeAll();
    session.stop();
    hostSignaling.close();
    await codex.stop();
  }, 30_000);
});
