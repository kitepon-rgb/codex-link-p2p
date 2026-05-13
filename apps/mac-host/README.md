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
     --relay https://codex-link.kitepon.dynv6.net \
     --bootstrap-token "$YOUR_BOOTSTRAP_TOKEN" \
     --display-name "kite Mac"
   ```

3. Start serving iPhone clients:

   ```bash
   codex-link-host start
   ```

4. From the iPhone app, scan or type the pairing code printed by the host.

## Architecture invariants (do not violate)

- **Relay is payload-blind.** It never decodes SDP / ICE candidates or session payloads. It only forwards opaque base64 envelopes and issues ephemeral TURN credentials.
- **Data plane is iPhone ⇄ Host direct** via WebRTC DataChannel `codex-link-session`. The host is the **answerer**, the iPhone is the **offerer**.
- **No broker concepts.** This package never emits `client.toHost` / `host.event` / `host.subscription.ready` / `appendHostEvent` / `routeToHost` etc. Enforced via ESLint guard in the repo.
- **Session token is one-time-plaintext** on issue; the Relay only stores its SHA-256 hash. The host stores the token in macOS Keychain (default), file (`$CODEX_LINK_HOME/tokens/...`), or env (`CODEX_LINK_HOST_TOKEN`).

## CLI

```
codex-link-host init   [--relay URL] [--bootstrap-token T] [--display-name N] [--host-platform macos|windows|linux]
codex-link-host start  [--relay URL]
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
