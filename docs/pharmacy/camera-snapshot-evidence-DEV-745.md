# Pharmacy camera snapshot evidence (DEV-745)

Status: **software implemented; hardware acceptance not run.** The DVR (Dahua DH-XVR1B16-I V2)
has no camera attached. Nothing here has been tested against MediaMTX, the DVR or a real camera.
Simulator capture is unchanged.

## Why a gateway-side service

MediaMTX, the existing on-prem gateway, documents no snapshot, still or JPEG endpoint (checked
against its README, Control API spec and `mediamtx.yml`). HLS playback does not provide event
evidence, and decoding HLS in the app server would add a video dependency there. Vendor still
APIs are not assumed, and the app never talks to camera devices.

DEV-745 therefore adds a small service that runs **on the gateway host, beside MediaMTX**
(`docker/camera-snapshot-gateway/`). It relies only on documented behavior:

- MediaMTX re-serves every path over RTSP (`rtspAddress: :8554`).
- `authInternalUsers` gives one dedicated reader `read` on specific paths, from loopback only.
  There is no anonymous grant, because a same-host HLS proxy would make LAN clients look like
  loopback.
- ffmpeg 5.0 or newer: its RTSP demuxer (`-rtsp_transport tcp -timeout`) and PNG encoder
  take one frame (`-frames:v 1 -f image2pipe -c:v png`). The service refuses older ffmpeg.

The service refuses to start unless the host mounts `/proc` with `hidepid`, because ffmpeg's
command line carries the MediaMTX reader secret. The systemd unit confines the service to
loopback plus the app's egress address, so it cannot
reach the DVR. The service reads the live path only. It never uses MediaMTX recording, playback or the API,
never connects to the DVR, never writes to disk, and does not change `record` (default
`false`). Old DVR recordings are untouched.

## End-to-end path

1. A tender, refund, daily close or cold-chain excursion writes a `PENDING` evidence row in the
   money or reading transaction, for an enabled camera that opted in (`counterEvidence`, or the
   `COLD_CHAIN` preset for the zone). The opt-in is checked again at capture, so an owner's
   opt-out stops pending and retried captures.
2. The `pharmacy.camera.snapshot.v1` platform job drops platform privileges (tenant RLS) and
   calls `captureCameraEvidence`.
3. `evidenceSnapshotAdapter(runtime, { vertical: 'pharmacy' })`:
   - **simulated** mode: the simulator, unchanged;
   - **mediamtx** mode with `CAMERA_SNAPSHOT_BINDINGS`: a scope-bound source;
   - anything else: `null`, which settles as `SNAPSHOT_UNSUPPORTED`.
4. The scope is built from the evidence row:
   `{ vertical: 'pharmacy', organizationId, branchId, gatewayId, cameraId, baseUrl }`. It is
   the same shape as the DEV-740 stream route. If the gateway's branch differs from the
   evidence branch, or no binding matches the exact scope, the row settles as
   `SNAPSHOT_UNSUPPORTED` with no request.
5. `snapshot-transport.ts` sends `GET <snapshotBaseUrl><path>/snapshot.png` with these
   protections:
   - Basic auth with a snapshot-only reader secret.
   - Connection pinned to the binding's RFC1918 IPv4 address, with TLS hostname verification.
   - No redirects, no compression, and `image/png` only.
   - At most 4 MiB, a 10 s deadline and 4 concurrent reads. The gateway scales stills to
     1280 px wide by default (at most 1920), which keeps real frames under the cap.
6. `png-still.ts` accepts only a complete PNG: signature, IHDR first, CRC on every chunk, legal
   colour type and bit depth, non-interlaced, at most 4096×4096, contiguous IDAT that inflates
   (bounded) to exactly the promised scanline size with legal row filters, and IEND last.
   Anything else stores nothing. What is stored is a canonical re-encode (IHDR, a bounded
   PLTE for palette images, one IDAT, IEND), so no metadata or hidden bytes reach storage.
7. The still goes to private tenant storage, and the row becomes `CAPTURED`. Gateway errors
   retry, then settle as `SNAPSHOT_UNAVAILABLE`. No URL, host, path or credential is ever
   persisted.
8. Existing retention applies: purge after the gateway's `retentionDays`, legal and fiscal
   holds, and read expiry.

## Configuration (server-only secret)

`CAMERA_SNAPSHOT_BINDINGS` is a JSON array, read only in `CAMERA_GATEWAY_MODE=mediamtx`. It is
kept separate from `CAMERA_MEDIAMTX_BINDINGS` so it does not touch the shared HLS binding list
that DEV-740 (#1415) is changing, and so snapshot credentials differ from HLS reader credentials.

```json
[
  {
    "vertical": "pharmacy",
    "organizationId": "<org id>",
    "branchId": "<branch id>",
    "gatewayId": "<camera_gateways.id>",
    "cameraId": "<cameras.id>",
    "baseUrl": "https://gateway.example.internal/",
    "snapshotBaseUrl": "https://gateway.example.internal:8899/",
    "address": "10.0.0.10",
    "path": "pharmacy/branch-1/counter-1",
    "username": "app-snapshot",
    "password": "<generated reader secret, at least 32 printable ASCII characters>"
  }
]
```

The rules: every key is required, and unknown keys are rejected. `vertical` must be
`pharmacy`. `baseUrl` must equal the registered gateway URL. `snapshotBaseUrl` must share its
hostname. `address` must be RFC1918 IPv4. Each camera and each stream appears once. A malformed
value disables stills (captures settle as `SNAPSHOT_UNSUPPORTED`) and logs the fixed event
`camera-snapshot-bindings-invalid`, without echoing anything; live viewing and other jobs keep
working.

For consoles, `evidenceSnapshotSupported(runtime, target)` returns true only for a provisioned
camera. DEV-740 can use it to replace its configured-mode "unsupported" label.

## Hardware acceptance checklist (not run)

This needs separate approval and a real test. Do not mark anything as passed without one.

- [ ] Owner provisions the gateway host, MediaMTX path, snapshot service, TLS certificate and
      firewall (see `docker/camera-snapshot-gateway/README.md`). Device credentials never go in
      chat or tickets.
- [ ] A camera is attached to the DVR channel, and the channel's codec and firmware are
      recorded. Old recordings are left untouched.
- [ ] A sale or excursion still is captured within the 15-minute window from the right branch
      camera.
- [ ] A cross-tenant or cross-branch scope, a wrong gateway URL, and an unbound camera each
      fail as `SNAPSHOT_UNSUPPORTED`.
- [ ] A revoked gateway or disabled camera fails as `CAMERA_UNAVAILABLE`.
- [ ] With the service or MediaMTX down, the capture retries, then fails as
      `SNAPSHOT_UNAVAILABLE`, with no secret in the stored row.
- [ ] With no video signal (the DVR's current state), the capture fails rather than storing a
      frame. This is unverified: the DVR may send a placeholder frame.
- [ ] Retention purge and legal holds behave as they do with the simulator.
- [ ] Privacy signage and consent text match real capture.
