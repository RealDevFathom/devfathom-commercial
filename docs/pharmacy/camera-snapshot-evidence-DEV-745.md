# Pharmacy camera snapshot evidence: capability finding (DEV-745)

Status: **blocked on a gateway prerequisite.** No real snapshot transport exists. Simulator
capture is unchanged. No hardware, DVR, network or staging acceptance has been run.

## Preflight result

| Source                                   | Snapshot transport? | Notes                                                                                                                                         |
| ---------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `develop` @ `396e2653`                   | No                  | `evidenceSnapshotAdapter` returns an adapter only in `simulated` mode. `mediamtx` mode fails closed as `SNAPSHOT_UNSUPPORTED`.                |
| `2c3d825e` (`fix/followup-rgap-cameras`) | No                  | Restaurant gateway lifecycle UI, privacy/retention and branch-source fixes. Not merged into `develop`. No still capture.                      |
| `f81ae0c3` (archived WHA-1357 gateway)   | No                  | Configured private **HLS** transport and audit redaction. The vertical-neutral copy already lives in `src/lib/cameras/mediamtx.ts`.           |
| MediaMTX upstream docs / Control API     | No                  | Neither documents a snapshot, still or JPEG endpoint. Community workarounds use an ffmpeg sidecar, which is not part of our reviewed gateway. |

HLS playback does not prove a snapshot transport. Taking a frame from an HLS segment
would mean decoding video in the app server, a new dependency and backend change, and
it would not establish _when_ the frame was captured relative to the sale or excursion.
The DVR model is unconfirmed, so vendor still APIs (ONVIF `GetSnapshotUri`, vendor CGI)
are not assumed. Reaching them directly would also break the rule that only the gateway
talks to camera devices.

## What this change does

It hardens the existing evidence seam (`src/lib/cameras/snapshots.ts`) so that any
future adapter is held to the same contract as the simulator:

- Bytes must carry the PNG signature, because stills are stored and served as
  `image/png`. JPEG bytes, HTML error pages, HLS manifests and non-byte values are refused.
- Bytes are capped at `CAMERA_SNAPSHOT_MAX_BYTES` (4 MiB).
- A rejected still is never written to tenant storage. The error message is fixed and
  never repeats adapter output.

The job's existing retry, `SNAPSHOT_UNAVAILABLE` on final attempt, capture window,
retention purge, legal hold, RLS scope and audit behavior are unchanged. So are the
simulator, router permissions and the live-viewing path (DEV-740).

## Prerequisite before real capture (coordinate via Linear with DEV-740)

A real adapter should be added only after a gateway owner provides a **documented,
reviewed** still endpoint on the same private gateway. Proposed contract, for review only
and not yet implemented:

1. A scope-bound transport read, `readSnapshot(scope: CameraBindingScope)`, alongside the
   existing HLS `read`. It must use the same static binding allowlist, private RFC1918
   address pinning, TLS verification, no redirects, no compression and the concurrency cap.
2. A fixed resource name on the binding's path. No caller-supplied URL, query or path.
3. PNG output, or an agreed change of the stored content type, with a byte limit no larger
   than `CAMERA_SNAPSHOT_MAX_BYTES` and a short deadline (≤ 5 s, since a still is small).
4. `evidenceSnapshotAdapter` then resolves the evidence row's organization, branch,
   gateway and camera into that scope after the existing `CAMERA_UNAVAILABLE` checks. It
   never resolves a bare `sourceRef`.
5. A per-binding capability flag (for example `snapshot: true`). Bindings without it keep
   failing closed as `SNAPSHOT_UNSUPPORTED`, so an HLS-only gateway stays honest.

## Hardware acceptance checklist (not run)

Requires separate approval and a real test; do not mark as passed without it.

- [ ] DVR model, firmware, channel and codec recorded (no passwords in chat or tickets).
- [ ] Gateway still endpoint documented by its owner and reviewed for auth, TLS and logs.
- [ ] A sale or excursion still is captured within the 15-minute window on the right branch camera.
- [ ] A cross-tenant or cross-branch binding mismatch fails closed.
- [ ] Revoked gateway or disabled camera fails as `CAMERA_UNAVAILABLE`.
- [ ] Gateway down fails as retry, then `SNAPSHOT_UNAVAILABLE`, with no credential in the stored row.
- [ ] Retention purge and legal hold behave as with the simulator.
- [ ] Privacy signage and consent text match the real capture behavior.
