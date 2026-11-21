# Pharmacy live camera viewing through the shared gateway (DEV-740)

Status: implementation with mocked/fixture tests. **Physical hardware acceptance is pending.**
No real DVR, camera, gateway, network or browser playback has been tested for this change.

## Hardware status

The owner first described the hardware as “Al Hua brand DVR and cameras”. Saad's label photo
(recorded on DEV-740) identifies the DVR as **Dahua Technology DH-XVR1B16-I, V2**. No serial
number or credential is recorded.

Dahua's published product specification for the XVR1B16-I V2 lists RTSP and ONVIF, with H.264
and H.265 encoding. That is a vendor datasheet, **not** proof that this unit works with the
gateway. Firmware version, enabled protocols, channel streams and codec on the actual device
remain **unverified**. Do not claim compatibility until they are checked on the device under
approved, safe test conditions.

The DVR currently has **no camera connected** and holds old recordings. Do not modify or delete
them. This change contains no recording playback, retention or export path, so it never reads,
alters or deletes DVR recordings. The app never talks to the DVR directly: the gateway owner
configures the DVR source in MediaMTX, and the app reads only the gateway's authenticated HLS
output.

Before any hardware test, collect these details **without asking for passwords in chat**:

- Firmware version (from the DVR's own information screen).
- Which protocols are actually enabled (RTSP, ONVIF) in the DVR's own settings.
- Channel numbers to view, and whether each is the main or sub stream.
- Video codec per channel (H.264 or H.265/HEVC) and resolution/frame rate.

H.265/HEVC playback depends on the browser, and neither the relay nor the app transcodes. The
owner decided on 20 Nov 2026 not to change anything on the DVR, so an H.265 channel stays H.265.
See "H.265 cameras" below for what the camera screen says and which browsers play it.

### Interim test without the DVR (optional, needs authorization)

Because no camera is connected, the app-to-gateway path could be exercised first with a
temporary test feed: a phone RTSP publisher application pushing to an owner-controlled MediaMTX
gateway, bound as a pharmacy camera. This would validate gateway TLS, reader credentials,
binding, grants and browser playback. It would **not** prove DVR compatibility. Feeding a phone
into the DVR over ONVIF is unverified. Do not install a phone app, connect any device or change
any network setting without Saad's explicit authorization for that specific test. Use a
non-production environment, and stop the publisher afterwards.

## What this change adds

- Pharmacy configured mode (`CAMERA_GATEWAY_MODE=mediamtx`) on `/pharmacy/cameras`:
  register a gateway with its exact `https://hostname[:port]/` base URL, register a camera by its
  gateway stream path name, run **Check configured connection** on the camera card, then open
  live view.
- `GET /api/pharmacy/cameras/[cameraId]/stream?grant=…[&segment=…]`, a same-origin HLS proxy.
- Shared transport reuse: the same `src/lib/cameras/mediamtx.ts` transport, manifest rewriting,
  response limits, private-address pinning and TLS verification as restaurant. Bindings now
  carry an optional `vertical` (`restaurant` | `pharmacy`). Bindings without `vertical` stay
  **restaurant-only**, so existing restaurant configuration is unchanged.
- The shared `CameraLivePlayer` (restaurant behavior unchanged) with grant release on close.

The simulator path (`CAMERA_GATEWAY_MODE=simulated`, development/test only) is unchanged.

## Security boundary

- **Credentials.** In configured mode the app accepts no DVR username or password. A
  registration that includes them is rejected. The camera credential row holds only a sealed
  no-secret marker. DVR source credentials stay in the gateway's protected configuration. The
  HLS reader username/password lives only in `CAMERA_MEDIAMTX_BINDINGS` (server secret
  configuration). It never reaches the browser, logs, audit input or responses.
- **No upstream URLs in the browser.** Manifests are rewritten to the authorized app endpoint.
  Unknown tags, absolute URLs, `@`, escapes, encryption keys and directories fail closed. Error
  bodies are fixed codes only. The workspace API returns no gateway base URL.
- **SSRF.** The database base URL and camera stream path never cause an outbound request on
  their own. A read happens only when an exact server binding matches vertical, organization,
  branch, gateway, camera and base URL. The socket connects to the binding's RFC1918 IPv4
  address without DNS. The base URL must be exactly `https://hostname[:port]/` (no IP literal,
  credentials, path, query or fragment). Stream paths are `[A-Za-z0-9_-]` segments. Media
  resource names are flat.
- **Per-request authorization.** Every manifest/segment request rechecks: signed-in tenant actor
  (not demo, not a platform support session), pharmacy vertical, session organization,
  `pharmacy-core` entitlement, `admin:access` capability, a grant for this viewer, tenant and
  camera that is unrevoked and unexpired, camera enabled, gateway active and unrevoked in the same
  tenant and branch, and branch access. It checks the grant again after the upstream read, so
  revocation or expiry during a slow read withholds the response. Media already delivered
  cannot be recalled.
- **Branch access.** The branch must be active. A session `ADMIN` of the organization may use
  every active branch (the existing counter convention). Anyone else needs an active pharmacy
  branch assignment to that branch.
- **Grants.** Live grants last 55 s, so a browser clock up to 5 s behind the server still
  accepts them (the shared session refuses more than 60 s left). The player renews 15 s before expiry and stops after 30
  renewals. That cap is client-side only; it is not a security boundary, because every issue
  and every stream request re-authorizes. Renewal requires a live grant the viewer holds for
  that camera. The prior grant is left to lapse (at most 15 s) so in-flight player requests
  are not cut off. Closing live view revokes both the current and the prior grant, and a
  grant that arrives after the view closed is revoked on arrival. Audit input for grant
  mutations is skipped; `previousGrantId` and `baseUrl` are also redacted globally, so a
  rejected gateway URL is never kept in the audit log.
- **Enabling.** In configured mode, changing camera settings (including **Enabled**) applies
  the same branch rule. "Enable after the configured check reports `ok`" is operator
  guidance; the server does not record or enforce the check result.
- **Fail closed.** Live endpoints return 503 unless the runtime is `mediamtx`. Disabling a
  camera, revoking its gateway, removing branch assignment or capability, or setting
  `CAMERA_GATEWAY_MODE=unavailable` stops subsequent reads.

## Not covered (tracked separately)

- **Evidence stills from the real gateway.** HLS live view does not provide transaction or
  cold-chain stills. DEV-745 adds a separate gateway-side snapshot service and its own
  server-only allowlist (`CAMERA_SNAPSHOT_BINDINGS`); see
  `docs/pharmacy/camera-snapshot-evidence-DEV-745.md`. The camera card asks the server
  whether this exact camera scope has a snapshot binding. It says so only when one exists;
  otherwise new tender, refund, daily-close and excursion evidence records the still as
  unavailable, and the card says that. Snapshot capture is also untested on hardware.
- Recording playback, retention enforcement on the gateway, PTZ, audio and export.
- Pharmacy gateway revocation UI. Use the camera's **Enabled** setting (owner) or
  `CAMERA_GATEWAY_MODE=unavailable` to stop viewing.
- Distributed rate limiting. The transport caps 16 concurrent reads per server instance.

## Gateway prerequisites (gateway/network owner)

Same baseline as `industry-specific-docs/restaurants/cameras/002-configured-mediamtx.md`:

1. A supported, patched on-prem host with a reviewed MediaMTX install. Configure the DVR RTSP
   source/channel explicitly: no scans, no credential guessing. Keep DVR credentials in the
   gateway's protected configuration and redact its logs.
2. An authenticated TLS HLS endpoint, reachable from the app over private routing, with a
   certificate valid for the configured hostname. Never expose anonymous HLS or the MediaMTX
   control API publicly. Restrict each reader to its intended path. Use ordinary `fmp4` or
   `mpegts` HLS; low-latency HLS is unsupported. Do not rely on any anonymous,
   IP-based or loopback-only MediaMTX read grant: behind a same-host reverse proxy, LAN
   clients can appear to come from loopback. Every HLS read must use the authenticated
   reader in item 4.
3. A pharmacy gateway and camera registered in the app. The camera card shows every binding
   identifier: camera, gateway, branch and organization IDs.
4. A dedicated least-privilege HLS reader username/password delivered through secret
   configuration. This is not the DVR password.
5. A binding entry with `"vertical": "pharmacy"` (placeholders below, not usable values):

```json
[
  {
    "vertical": "pharmacy",
    "organizationId": "registered-organization-id",
    "branchId": "registered-pharmacy-branch-id",
    "gatewayId": "registered-gateway-id",
    "cameraId": "registered-camera-id",
    "baseUrl": "https://camera-gateway.example.internal/",
    "address": "10.20.30.40",
    "path": "pharmacy-counter-1",
    "username": "dedicated-hls-reader",
    "password": "OWNER_SUPPLIED_SECRET"
  }
]
```

Bindings load at startup, so changes need the normal reviewed restart. Unknown fields, unknown
verticals, duplicate camera or upstream-path mappings, malformed URLs and non-RFC1918 addresses
reject startup without echoing values.

## Supported relay versions and reference configuration (DEV-1003)

### Supported MediaMTX versions

| MediaMTX release            | How the app reads it                                                                                        | Tested against the real release binary |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| v1.17.1                     | No relay sessions: the reader login is sent and checked on every request.                                   | v1.17.1, 20 Nov 2026                   |
| v1.18.0 to v1.21.4          | Relay sessions: the app follows the relay's own session step and renews the session when the relay ends it. | v1.18.0 and v1.21.4, 20 Nov 2026       |
| Anything newer than v1.21.4 | Not yet checked. Test it before upgrading the relay.                                                        | —                                      |

The owner's relay is MediaMTX v1.21.4 (Homebrew). The app was first built against the relay's
documented HLS behaviour without a real relay test; no earlier version was recorded, so the
table above is the supported range: **MediaMTX v1.17.1 to v1.21.4**.

If **Check configured connection** reports "The camera relay answered in a way this app does not
support", the relay is outside this range or does not match the reference configuration below.

### How the app reads a v1.18+ relay

MediaMTX v1.18.0 and later manage HLS sessions (`internal/servers/hls/http_server.go`,
`session.go` and `muxer_instance.go` in the MediaMTX source):

1. `GET /<path>/index.m3u8` answers `302` to `/<path>/index.m3u8?cookieCheck=1`.
2. That request checks the reader login and opens a session. The session secret comes back as
   the `hlsSession` cookie, or as a `session` query parameter for clients without cookies.
3. Every later playlist and segment request must carry the secret from the same client address.
   A missing or unknown secret gets `401 {"error":"session not found"}`. The relay ends a session
   after 30 seconds without requests.

What the app does (`src/lib/cameras/mediamtx.ts`):

- It follows exactly one redirect: the relay's own `/<path>/index.m3u8?cookieCheck=1` step,
  compared as an exact string. A redirect to any other host, address, scheme, port, path or file
  is never followed and the check reports the relay as unsupported.
- The connection still goes only to the binding's private address, with TLS verification and the
  certificate's host name check on.
- It sends `cookieCheck=1` and `hlsSession` cookies, so the relay's playlists name segments
  without the secret. If a relay still puts `?session=…` on playlist lines, the app removes it and
  refuses any playlist that still contains the secret afterwards.
- The session secret and the viewer login stay on the app server. They are never logged, never
  returned to the browser and never sent anywhere but that relay. The browser only talks to
  `/api/pharmacy/cameras/…` or `/api/restaurant/cameras/…`.
- When the relay ends a session, the next request gets `401`. The app opens a new session once
  and retries. Concurrent requests share one renewal. If a fresh session is still refused, the
  check reports the relay as unsupported.
- The app does **not** use `hlsCDNSecret`. That setting turns the relay's login check off.
- Limits are unchanged: at most one session per binding in memory, sixteen concurrent reads per
  app server, ten seconds per request, 256 KiB per playlist and 16 MiB per segment.

**Check configured connection** now reads the master playlist and the first media playlist, so
`ok` also proves the session step works. It still does not prove that frames decode in a browser.

Failure meanings are unchanged: `not-configured`, `credentials-missing`, `auth-failed` (wrong
viewer login), `gateway-unreachable` (relay stopped, routing or TLS) and `unsupported-stream`.
`relay-unsupported` is new: the relay answered with a redirect or session flow outside the
supported range.

### Reference relay configuration

Checked key by key against the `mediamtx.yml` shipped with MediaMTX v1.21.4. Every key also
exists in v1.17.1 and v1.18.0 except `moq`, which arrived in v1.19.0: **on v1.17.1 or v1.18.0
delete the `moq` line**, or the relay refuses to start. The integration test
(`src/lib/cameras/mediamtx.relay.integration.test.ts`) starts the real relay from this exact
block, with only the placeholders replaced.

Replace the placeholders: reader password, private address and port, certificate files, path
name and the DVR source. The DVR login lives only in this protected file. Restrict the file to
the relay's service account.

<!-- mediamtx-reference-config -->

```yaml
logLevel: info

authMethod: internal
authInternalUsers:
  # The app's dedicated reader. No anonymous "any" user, no publish, API, metrics or pprof.
  - user: devfathom-hls-reader
    pass: REPLACE_WITH_READER_PASSWORD
    ips: []
    permissions:
      - action: read
        path: pharmacy-counter-1

api: false
metrics: false
pprof: false
playback: false

# The relay pulls the DVR itself (paths below), so it needs no RTSP, RTMP, WebRTC, SRT or MoQ
# server. MoQ is on by default from v1.19.0 and opens extra ports.
rtsp: false
rtmp: false
webrtc: false
srt: false
moq: false

hls: true
hlsAddress: 10.20.30.40:8888
hlsEncryption: true
hlsServerKey: /etc/mediamtx/camera-gateway.key
hlsServerCert: /etc/mediamtx/camera-gateway.crt
# Only the app server reads the relay; browsers never contact it.
hlsAllowOrigins: []
hlsTrustedProxies: []
hlsAlwaysRemux: false
# fmp4 carries H.264 and H.265. mpegts carries H.264 only. lowLatency is not supported by the app.
hlsVariant: fmp4
hlsSegmentCount: 7
hlsSegmentDuration: 1s
hlsSegmentMaxSize: 50M
hlsDirectory: ''
hlsMuxerCloseAfter: 60s

paths:
  pharmacy-counter-1:
    source: rtsp://DVR_VIEWER:DVR_VIEWER_PASSWORD@192.168.1.108:554/cam/realmonitor?channel=6&subtype=1
    rtspTransport: tcp
```

Notes on the keys:

- `hlsCDNSecret` is left out on purpose (its default is empty). Never set it: a request carrying
  it skips the reader login.
- `hlsVariant: fmp4` is required for H.265. With `mpegts`, MediaMTX refuses an H.265 source
  ("the MPEG-TS variant of HLS supports H264 video only") and the check reports the gateway as
  unreachable.
- `hlsEncryption: true` with a certificate valid for the binding's host name. A certificate from
  a private CA (for example mkcert) is fine; give the app server that CA through
  `NODE_EXTRA_CA_CERTS`. TLS verification is never turned off.
- The DVR source URL format shown is Dahua's documented RTSP form (`subtype=1` is the sub
  stream). Confirm it on the device; nothing on the DVR is changed.

### H.265 cameras

Neither the relay nor the app converts video, and the DVR stays as the owner set it. The app reads
the codec from the relay's playlist (`CODECS="hvc1…"` or `"hev1…"`):

- **Check configured connection** adds: "This camera sends H.265 (HEVC) video, which the app does
  not convert. Safari on Mac, iPhone and iPad plays it. Chrome and Edge play it only on computers
  with H.265 hardware decoding. Other browsers may show no picture."
- Live view stops with a plain H.265 message, instead of a black picture, when the browser cannot
  decode it.

Record the browser, version and computer for every H.265 playback result.

## Hardware acceptance checklist (pending; needs separate authorization)

Run only after the exact device is confirmed and the owner explicitly authorizes a test in a
non-production environment. Record evidence (screenshots and timestamps), never credentials.

- [x] Device model label recorded from photo: Dahua DH-XVR1B16-I V2 (DEV-740). No serial or
      credential recorded.
- [ ] Firmware, enabled protocols, channel, stream (main/sub) and codec recorded from the device.
- [ ] A camera is connected to the DVR (none is today). Existing recordings are left untouched.
- [ ] (Optional, separately authorized) Phone-publisher feed to the owner gateway plays through
      `/api/pharmacy/cameras/...`. Record it as a gateway path test, not DVR acceptance.
- [ ] Gateway owner confirms the MediaMTX source config, reader restriction, TLS hostname and
      private route. The app operator receives no DVR password.
- [ ] Pharmacy gateway and camera registered. The binding added with `"vertical": "pharmacy"`.
      The app restarted through the reviewed process.
- [ ] **Check configured connection** returns `ok`. (This proves a readable manifest only.)
- [ ] Owner enables the camera. **Open live view** shows real moving frames in each target
      browser (record browser and OS versions).
- [ ] The browser network panel shows only `/api/pharmacy/cameras/...` URLs: no gateway
      hostname, private IP, `rtsp://` or credentials. Page source and console are clean.
- [ ] Closing live view revokes the current and prior grants. Both URLs then return 401.
- [ ] Viewing continues across at least two renewals (more than 2 minutes).
- [ ] Disabling the camera, or removing a non-admin user's branch assignment, stops the next
      segment request (403).
- [ ] A user from another branch or tenant cannot obtain a grant or stream.
- [ ] Restaurant cameras on the same deployment still play, and their legacy bindings are
      unchanged.
- [ ] H.265 channels: **Check configured connection** shows the H.265 line; playback outcome
      recorded per browser (plays, or the plain H.265 message).
- [ ] Relay version recorded (`mediamtx --version`) and inside the supported range above.
- [ ] Evidence stills: without a DEV-745 snapshot binding, new events show the still
      unavailable; with one, follow the DEV-745 acceptance checks.

Until every item is recorded on a confirmed device, report hardware status as **pending**.
