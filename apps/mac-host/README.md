# @codex-link/host

Codex Link Host — runs on Mac / Win, brokers iPhone ⇄ local Codex CLI over **WebRTC DataChannel** (Relay-relayed signaling, but data plane is **direct peer-to-peer with DTLS-SRTP E2E encryption**).

This is the **host** half of [codex-link-p2p](https://github.com/kitepon-rgb/codex-link-p2p). It pairs with the Codex Link iPhone app and forwards Codex events / commands between the two sides without exposing payload to the Relay.

## Install

```bash
npm install -g @codex-link/host
# or
pnpm add -g @codex-link/host
```

Native binaries for WebRTC are pre-built via [`node-datachannel`](https://github.com/murat-dogan/node-datachannel) — no extra build chain needed on darwin-arm64 / darwin-x64 / linux-x64 / win32-x64.

## Quick start

1. Get a **bootstrap token** from your Relay operator (or run your own from this repo's `services/relay`).
2. Initialize the host (creates `~/.codex-link-p2p/host.json` and stores the device session token in your Keychain):

   ```bash
   codex-link-host init \
     --relay https://codex-link-p2p.kitepon.dynv6.net \
     --bootstrap-token "$YOUR_BOOTSTRAP_TOKEN" \
     --display-name "kite Mac"
   ```

3. Start serving iPhone clients:

   ```bash
   codex-link-host start
   ```

4. In another terminal, issue a pairing code + QR code:

   ```bash
   codex-link-host pair
   ```

   The QR is printed to the terminal (block-character art). Open it in
   Preview.app or any window large enough for the iPhone camera to read.

5. On the iPhone:
   1. Open the Codex Link app (fresh install if it was previously paired).
   2. Tap **Scan QR** and read the code printed in step 4.
   3. The app calls `/api/device-session/register` → `/api/device-session/pair`
      on the Relay, then connects to the Mac Host over WebRTC DataChannel.
   4. The header badge transitions from `接続中…` → `直結` / `直結 (NAT越え)` /
      `中継` depending on the connection path.

### Run as a launchd agent (recommended for daily use)

Once `init` + `pair` work end-to-end, replace the manual `codex-link-host start`
loop with a launchd agent so the host comes up at every login and auto-restarts
on crash.

```bash
# From the repo root:
pnpm --filter @codex-link/host build   # 必須: dist/cli.js を更新
bash apps/mac-host/launchd/install-launchd.sh

# Status:
launchctl list | grep dev.codex-link
tail -f ~/Library/Logs/codex-link-p2p-mac-host.log

# Uninstall:
launchctl unload ~/Library/LaunchAgents/dev.codex-link-p2p.mac-host.plist
rm ~/Library/LaunchAgents/dev.codex-link-p2p.mac-host.plist
```

If you previously installed the broker-version agent (`dev.codex-link.mac-host`),
unload it first to avoid both processes racing for the same WS slot:

```bash
launchctl unload ~/Library/LaunchAgents/dev.codex-link.mac-host.plist
rm ~/Library/LaunchAgents/dev.codex-link.mac-host.plist
```

## Architecture invariants (do not violate)

- **Relay is payload-blind.** It never decodes SDP / ICE candidates or session payloads. It only forwards opaque base64 envelopes and issues ephemeral TURN credentials.
- **Data plane is iPhone ⇄ Host direct** via WebRTC DataChannel `codex-link-session`. The host is the **answerer**, the iPhone is the **offerer**.
- **No broker concepts.** This package never emits `client.toHost` / `host.event` / `host.subscription.ready` / `appendHostEvent` / `routeToHost` etc. Enforced via ESLint guard in the repo.
- **Session token is one-time-plaintext** on issue; the Relay only stores its SHA-256 hash. The host stores the token in macOS Keychain (default), file (`$CODEX_LINK_HOME/tokens/...`), or env (`CODEX_LINK_HOST_TOKEN`).

## CLI

```
codex-link-host init   [--relay URL] [--bootstrap-token T] [--display-name N] [--host-platform macos|windows|linux]
codex-link-host start  [--relay URL]
codex-link-host pair   [--relay URL]   # 1 回限りの pairing code + QR を発行
codex-link-host help
```

### Environment overrides

| Var | Effect |
|---|---|
| `CODEX_LINK_RELAY_URL` | Default Relay base URL (overridable by `--relay`) |
| `CODEX_LINK_HOST_BOOTSTRAP_TOKEN` | Bootstrap token for `init` (instead of `--bootstrap-token`) |
| `CODEX_LINK_HOME` | Config + token base dir (default: `~/.codex-link-p2p`) |
| `CODEX_LINK_HOST_TOKEN` | Use this session token instead of reading from Keychain / file |
| `CODEX_LINK_TOKEN_STORE` | Force `file` / `keychain` token store regardless of OS |

## License

MIT.
