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

H.265/HEVC playback in browsers is limited, and the gateway does not transcode. A channel set to
H.265 may fail with the codec-unsupported message. Changing the DVR codec (for example to H.264
on a sub stream) is a device setting change and needs separate authorization from the owner.

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
- **Grants.** Live grants last 60 s. The player renews 15 s before expiry and stops after 30
  renewals. Renewal requires a live grant the viewer holds for that camera. The prior grant
  is left to lapse (at most 15 s) so in-flight player requests are not cut off.
  Closing live view revokes the last grant. Audit input for grant mutations is skipped;
  `previousGrantId` is also redacted globally.
- **Fail closed.** Live endpoints return 503 unless the runtime is `mediamtx`. Disabling a
  camera, revoking its gateway, removing branch assignment or capability, or setting
  `CAMERA_GATEWAY_MODE=unavailable` stops subsequent reads.

## Not covered (tracked separately)

- **Evidence stills from the real gateway.** HLS live view does not provide transaction or
  cold-chain snapshot capture. In configured mode the snapshot adapter is absent, so new tender,
  refund, daily-close and excursion evidence records the still as unavailable. The console says
  so. Tracked in Linear **DEV-745**.
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
   `mpegts` HLS; low-latency HLS is unsupported.
3. A pharmacy gateway and camera registered in the app. Their IDs are shown on the camera card.
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
- [ ] Closing live view revokes the grant. The old grant URL then returns 401.
- [ ] Viewing continues across at least two renewals (more than 2 minutes).
- [ ] Disabling the camera, or removing a non-admin user's branch assignment, stops the next
      segment request (403).
- [ ] A user from another branch or tenant cannot obtain a grant or stream.
- [ ] Restaurant cameras on the same deployment still play, and their legacy bindings are
      unchanged.
- [ ] H.265 channels: playback outcome recorded honestly (supported or unsupported message).
- [ ] Evidence stills: confirm new events show the still unavailable (DEV-745 not implemented).

Until every item is recorded on a confirmed device, report hardware status as **pending**.
