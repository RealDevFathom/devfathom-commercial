# Camera snapshot gateway (DEV-745)

MediaMTX has no still-image endpoint. This small service runs on the on-prem gateway host,
next to MediaMTX, and answers `GET /<path>/snapshot.png` with one PNG frame taken from
MediaMTX's own loopback RTSP output (`rtsp://127.0.0.1:8554/<path>`). The DevFathom app
(`src/lib/cameras/snapshot-transport.ts`) calls it to capture pharmacy counter evidence stills.

`server.mjs` is plain Node 22 ESM with zero npm dependencies. It needs Node.js 22 (not Bun:
its HTTP server timeouts are not verified) and **ffmpeg 5.0 or newer**. ffmpeg 4.x reads the
RTSP `-timeout` option as listen mode, so the service refuses to start on it.

> **Not tested against MediaMTX, the DVR, or any camera.** The automated tests use injected
> fakes and, for the real-ffmpeg test, a synthetic `lavfi` source in place of the RTSP input.
> Validate on the gateway host before relying on it.

## Security model

- **No recordings, ever.** It only opens the live RTSP output of a configured path. It never
  reads recording files, never calls the MediaMTX API or playback server, never talks to the
  DVR (Dahua DH-XVR1B16-I V2) directly, never writes to disk, and never changes MediaMTX
  `record` (default `false`), playback, or any path `source`. Existing DVR recordings are not
  touched. MediaMTX itself still pulls the path from its configured source, as it does for
  live view.
- **Loopback RTSP, authenticated.** `rtspOrigin` must be `rtsp://127.0.0.1:<port>` or
  `rtsp://[::1]:<port>` with no path or credentials. ffmpeg reads as a dedicated MediaMTX
  user (`rtspReader`) with `read` on the snapshot paths only, from loopback only
  (`mediamtx.snapshot.example.yml`). There is deliberately no anonymous loopback grant: a
  same-host reverse proxy for HLS would make every LAN client look like loopback.
- **Network-confined.** The systemd unit allows only loopback and the app's egress address,
  so the process cannot reach the DVR or the rest of the LAN.
- **Allowlist + per-path secret.** Only paths listed in `config.json` are served. Each needs
  HTTP Basic auth; the config stores only `sha256(secret)`. Comparisons use
  `crypto.timingSafeEqual`, the hash work runs even for unknown paths, and an unknown path,
  wrong secret or missing header all get the same `401`.
- **Strict request shape.** `GET` only (`405` otherwise). The URL must be exactly
  `/<path>/snapshot.png`: no query, `%`, `..` or `//` (`404`).
- **Bounded ffmpeg.** `shell: false`, fixed argument vector, env `PATH=/usr/bin:/bin` only,
  at most `maxConcurrent` processes (`503` + `Retry-After: 1` beyond that), output capped at
  `maxBytes` (`502`), hard deadline `timeoutMs + 1000` ms (`504`), killed with `SIGKILL` on any
  of those or when the client disconnects. stderr is discarded unread (it can contain URLs).
- **Validated output.** `200 image/png` only when ffmpeg exits 0 and the bytes are a complete
  PNG (signature, IHDR first with 1..4096 dimensions, valid chunk CRCs, IDAT, final IEND with
  nothing after). Anything else is `502`. Responses carry `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`; error bodies are fixed strings.
- **Quiet logs.** One JSON line per request on stdout:
  `{ at, path, status, ms, bytes }`. `path` is set only for configured paths. Credentials,
  usernames, the Authorization header and ffmpeg output are never logged. A client that
  disconnects before the answer is logged as status `499`.
- **TLS.** HTTPS only, TLS 1.2 minimum, TLS handshake timeout 5 s, `headersTimeout` 5 s and
  `requestTimeout` 10 s (checked every second), `maxHeaderSize` 8192, one request per
  connection, at most 64 connections.

## Install and operate (owner)

1. **Reader secret, per path.** Generate a random secret of at least 32 characters and hash it:

   ```sh
   SECRET="$(openssl rand -base64 33 | tr -d '\n')"
   printf '%s' "$SECRET" | sha256sum | cut -d' ' -f1
   ```

   Put only the hex hash in `config.json` as `passwordSha256`. Put the plain secret only in
   the app's server-only `CAMERA_SNAPSHOT_BINDINGS` (`password`, with the same `username` and
   `path`). Never store the plain secret on the gateway host.

2. **Config.** Copy `config.example.json` to `/etc/devfathom-snapshot/config.json`, set
   `listen.host` to the gateway's LAN IPv4, keep `rtspOrigin` on loopback, and list one entry
   per camera path. Unknown keys are rejected. Check it with:

   ```sh
   node -e "import('/opt/devfathom/camera-snapshot-gateway/server.mjs').then(m => m.parseConfig(require('fs').readFileSync('/etc/devfathom-snapshot/config.json','utf8')))"
   ```

3. **TLS.** `tls.crt` must be valid for the gateway hostname the app uses in
   `snapshotBaseUrl` (the same host as the HLS gateway `baseUrl`), issued by a CA the app
   trusts. Store `tls.key` readable only by root and the `devfathom-snapshot` group.

4. **MediaMTX.** Generate a second, URL-safe secret (`openssl rand -hex 24`) for the
   snapshot reader. Put it in `config.json` `rtspReader.password` and in the snippet's `pass`.
   Apply `mediamtx.snapshot.example.yml`: one authenticated, loopback-only reader with `read`
   on each snapshot path. Remove the stock anonymous `read`/`publish`/`playback` catch-all,
   keep `api`, `metrics`, `pprof` and `playback` disabled (or authenticated), and do not change
   `record`, playback or the DVR source.

5. **Service.** Review `camera-snapshot-gateway.service` (an example). Set `IPAddressAllow`
   to loopback plus the app's egress address(es), install it, then
   `systemctl enable --now camera-snapshot-gateway`. Logs: `journalctl -u camera-snapshot-gateway`.

6. **Firewall.** Allow the listen port only from the DevFathom app's egress address(es). Do
   not expose it to the LAN at large or the internet. MediaMTX's RTSP port needs no new rule.

7. **Rotate** a secret by updating both the hash in `config.json` (then restart the service)
   and the app's `CAMERA_SNAPSHOT_BINDINGS`.

## Files

| File                              | Purpose                                  |
| --------------------------------- | ---------------------------------------- |
| `server.mjs`                      | The service (`main()` when run directly) |
| `config.example.json`             | Config template (placeholder hash)       |
| `mediamtx.snapshot.example.yml`   | MediaMTX `authInternalUsers` snippet     |
| `camera-snapshot-gateway.service` | Hardened systemd unit (example)          |

Tests: `npx vitest run tests/camera-snapshot-gateway`.
