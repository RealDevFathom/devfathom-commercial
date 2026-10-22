# Issue #457: archived WHA-257 work is already present

Issue #457 asked whether the five commits preserved as `archive/rescue/WHA-257` should be restored.
The current tree already contains the valuable behavior described by every archived commit, together
with stricter tenant and credential boundaries. Reopening or cherry-picking the archive would therefore
duplicate or regress the current implementation.

## Current-code evidence

- **Camera gateway core (`5e868289`)**: the runtime is fail-closed when no gateway is configured,
  restricts simulation to development/test, and exposes the live MediaMTX transport without permitting
  legacy bare-camera-ID reads (`src/lib/cameras/camera-gateway-runtime.ts:21-62`). The stream endpoint
  resolves the signed-in tenant, verifies the restaurant integration entitlement, and checks the grant,
  viewer, camera, gateway, branch, and organization before reading media
  (`src/app/api/restaurant/cameras/[cameraId]/stream/route.ts:12-78`).
- **Brand adapters and manual fallback (`8e104338`)**: the shared contract includes supported brand
  families plus a manual option (`src/lib/cameras/contract.ts:29-31`), while resolution gives explicit
  operator input precedence over presets and otherwise falls back to ONVIF discovery
  (`src/lib/cameras/adapters.ts:89-134`). Probe results are deliberately coarse and exceptions are
  collapsed without logging credential-bearing transport errors (`src/lib/cameras/adapters.ts:208-237`).
- **Console and stream proxy (`4078f855`)**: the restaurant console handles unavailable gateways without
  simulating footage, registers cameras, opens live views, and requests short-lived grants
  (`src/components/restaurant/restaurant-cameras-console.tsx:54-99`,
  `src/components/restaurant/restaurant-cameras-console.tsx:114-203`). The API proxy rejects recording
  requests, validates tenant-scoped authorization, rewrites HLS manifests, and serves responses with
  private/no-store caching (`src/app/api/restaurant/cameras/[cameraId]/stream/route.ts:21-95`).
- **Playback controls (`b0469c78`)**: the player supports native HLS or a lazy-loaded HLS client, handles
  loading, timeout, playback and authorization failures, tears the stream down on close, and renders
  native playback controls (`src/components/restaurant/restaurant-camera-player.tsx:26-159`). The console
  also states explicitly when recorded playback is unsupported rather than substituting live footage
  (`src/components/restaurant/restaurant-cameras-console.tsx:204-235`).
- **Persistent credential key (`9582ae9e`)**: registration refuses to persist credentials unless
  `CAMERA_CREDENTIAL_KEY` exists, seals the username/password, and suppresses request inputs from audit
  capture (`src/server/routers/restaurant-cameras.ts:310-359`). A focused source-level regression test
  asserts that this path fails closed and cannot restore an ephemeral random-key fallback
  (`src/server/routers/restaurant-cameras.test.ts:16-20`).

## Recovery decision

All five archived commits were **skipped as obsolete**:

| Archived commit | Decision | Why |
| --- | --- | --- |
| `5e868289` | Skip | The gateway core and tenant-scoped authorization already exist. |
| `8e104338` | Skip | Brand presets, editable overrides, and the manual RTSP/ONVIF path already exist. |
| `4078f855` | Skip | The console and tenant-authorized HLS proxy already exist. |
| `b0469c78` | Skip | Live playback controls and explicit recording limitations already exist. |
| `9582ae9e` | Skip | Persistent-key enforcement and its focused regression test already exist. |

No archive code is ported. In particular, the current implementation's tenant checks, fail-closed gateway
configuration, coarse credential-safe diagnostics, and no-secret logging behavior must not be replaced by
older equivalents.

## Verification limitation

The supplied archive object and a `main` ref are not included in this checkout, and the checkout has no
`origin` remote. Fetching the named tag directly from GitHub is also blocked by the environment's HTTP 403
proxy. Consequently, an object-level `git diff main...archive/rescue/WHA-257` could not be produced here.
The recovery decision above compares the five supplied commit subjects with their concrete current-tree
implementations; it does not claim that inaccessible archive-only bytes were inspected.
