// Relay HTTP server bootstrap.
//
// `node services/relay/dist/server.js` (build 後) で起動するエントリー.
// HTTP の他に Phase 2.5b で WS upgrade を attach する.

import { createServer, type Server } from "node:http";

import { loadConfig, type RelayConfig } from "./config.js";
import { createHttpHandler, type HttpHandlerContext } from "./http.js";
import { createRelayState, type RelayState } from "./state.js";
import {
  attachWebsocket,
  closeAllConnections,
  createConnections,
  type AttachedWebsocket,
  type RelayConnections,
} from "./websocket.js";

export interface CreateRelayServerInput {
  readonly state: RelayState;
  readonly config: RelayConfig;
  readonly now?: () => number;
  readonly connections?: RelayConnections;
}

export interface CreatedRelayServer {
  readonly server: Server;
  readonly connections: RelayConnections;
  readonly ws: AttachedWebsocket;
}

export const createRelayServer = ({
  state,
  config,
  now,
  connections,
}: CreateRelayServerInput): CreatedRelayServer => {
  const clock = now ?? (() => Date.now());
  const conns = connections ?? createConnections();
  const ctx: HttpHandlerContext = {
    state,
    config,
    now: clock,
  };
  const server = createServer(createHttpHandler(ctx));
  const ws = attachWebsocket({
    httpServer: server,
    context: {
      state,
      config,
      connections: conns,
      now: clock,
    },
  });
  return { server, connections: conns, ws };
};

export interface StartedServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

export const startRelayServer = async (
  created: CreatedRelayServer,
  bindHost: string,
  port: number,
): Promise<StartedServer> => {
  const { server, ws, connections } = created;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bindHost);
  });
  const addr = server.address();
  const actualPort =
    typeof addr === "object" && addr !== null ? addr.port : port;
  return {
    server,
    host: bindHost,
    port: actualPort,
    close: async () => {
      closeAllConnections(connections);
      await ws.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
};

// CLI entry: `node dist/server.js`
const isEntrypoint = (): boolean => {
  // Node ESM では `import.meta.url` を使うが、verbatimModuleSyntax のため
  // 単純な比較は避け、process.argv[1] と一致するかで判定する。
  const arg = process.argv[1];
  if (typeof arg !== "string") return false;
  return arg.endsWith("server.js") || arg.endsWith("server.ts");
};

if (isEntrypoint()) {
  const config = loadConfig({ env: process.env });
  const state = createRelayState();
  const created = createRelayServer({ state, config });
  startRelayServer(created, config.bindHost, config.port)
    .then((s) => {
      // 構造化ログ (JSON Lines). 詳細化は Phase 2.5b 以降.
      process.stdout.write(
        `${JSON.stringify({
          msg: "relay_listening",
          host: s.host,
          port: s.port,
        })}\n`,
      );
    })
    .catch((err: Error) => {
      process.stderr.write(
        `${JSON.stringify({
          msg: "relay_start_failed",
          error: err.message,
        })}\n`,
      );
      process.exit(1);
    });
}
