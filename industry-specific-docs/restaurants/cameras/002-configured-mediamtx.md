# Configured MediaMTX live transport (WHA-1357)

Status: implementation with protocol fixtures; hardware and staging acceptance pending.

## Boundary

The server can read an explicitly provisioned MediaMTX HLS source through the existing
tenant/user stream-grant endpoint. It does not discover, configure, authenticate to, or
deploy anything on a DVR. “Alhua DVR” is unconfirmed; do not infer Dahua compatibility.

The existing legacy adapter methods have no tenant/branch arguments. In real mode they
fail closed rather than accepting bare camera IDs. The scoped transport requires an exact
organization, branch, gateway, camera and registered base URL match. The stream route
rechecks actor, entitlement, grant expiry/revocation/viewer, camera enabled state and
gateway tenant/branch/revocation before each read. It checks expiry again after the read.
Revocation prevents subsequent requests; already delivered media cannot be recalled.

The server-side static binding is the allowlist. Database gateway URLs and camera
`sourceRef` values cannot cause arbitrary outbound requests. TLS verification stays on;
the socket uses the binding's private IPv4 address without resolving DNS. Only RFC1918
addresses are accepted. Each response has a ten-second deadline, a 256 KiB manifest or
16 MiB media limit, no redirects or compression, and at most sixteen concurrent reads
per server transport instance. This is not a distributed per-user rate limiter.

All supported HLS playlist references, including master variants and fMP4 initialization
maps, return through the same authorized app endpoint. URLs, query strings, escaped paths,
directories, encryption keys and unknown tags fail closed. Configure ordinary `fmp4` or
`mpegts` HLS; the low-latency variant is intentionally unsupported. Media bytes are carried
unchanged; the app neither decodes nor transcodes them.

## Owner-managed prerequisite

Before enabling this mode, the staging/network owner must provide:

1. A supported, patched on-prem host with a reviewed MediaMTX installation and explicit
   DVR RTSP source/channel configuration. No scans or credential guessing. Keep RTSP
   credentials in the gateway's protected configuration and redact its logs.
2. An authenticated TLS endpoint for HLS, accessible to the app over private routing.
   Its certificate must validate for the configured hostname. Do not expose an anonymous
   HLS endpoint or the MediaMTX control API publicly. Disable anonymous reader defaults;
   restrict each reader to the intended path. Disable unused services and audio upstream.
3. A registered app gateway and camera, plus exact tenant/branch/gateway/camera IDs.
   The gateway's registered base URL must be exactly `https://hostname[:port]/`.
4. A separate least-privilege HLS reader username/password delivered to the app through
   its secret configuration. This is not the DVR password or the `rcg_` enrollment secret.

The existing AES-GCM camera credential store remains write-only. This implementation
does not decrypt those credentials or automatically provision MediaMTX. Updating the
wizard password does not rotate the independently provisioned gateway source credential.
Enrollment-secret rotation likewise does not rotate the HLS reader password; gateway
revocation still denies subsequent application reads.

No dependency, service, certificate, secret or deployment was created by this change.

## App configuration

Set `CAMERA_GATEWAY_MODE=mediamtx` and `CAMERA_MEDIAMTX_BINDINGS` to a JSON array with
these fields (placeholders below are not usable credentials):

```json
[
  {
    "organizationId": "registered-organization-id",
    "branchId": "registered-branch-id",
    "gatewayId": "registered-gateway-id",
    "cameraId": "registered-camera-id",
    "baseUrl": "https://camera-gateway.example.internal/",
    "address": "10.20.30.40",
    "path": "organization-camera-path",
    "username": "dedicated-hls-reader",
    "password": "OWNER_SUPPLIED_SECRET"
  }
]
```

The path maps to `/<path>/index.m3u8` on MediaMTX. Keep one unique upstream path per
camera binding. Unknown fields, duplicate mappings, malformed URLs and invalid addresses
reject startup without reflecting configuration values. Missing reader credentials are
reported as a diagnostic without opening a connection. Bindings are loaded at startup;
operator-controlled configuration changes require the normal reviewed restart process.
`available: true` means configured, not hardware healthy.

`configuredConnectionDiagnostics({ cameraId })` is an admin/entitlement-gated query for
registered cameras. It returns `not-configured`, `credentials-missing`, `auth-failed`,
`gateway-unreachable`, `unsupported-stream`, or `ok`. `ok` proves only a readable supported
master manifest. It does not prove video frames, codecs or successful DVR authentication.
A failed upstream DVR source may appear as an unavailable/missing HLS stream; this endpoint
cannot distinguish its root cause. It never returns an upstream error body or URL.

The old pre-registration simulated connection test returns an explicit precondition
failure in real mode. Registration remains available through the existing administrative
contract; the new diagnostic query is not yet exposed in the wizard UI. Recording,
retention usage, PTZ, audio and export are not implemented by this live transport.

## Compatibility and acceptance gates

The current console uses native browser HLS. Test on a supported native-HLS browser and
supported OS first. Windows 98/Vista/7 cannot host this modern browser/Node application;
use a separate supported gateway host and viewing workstation. No universal Windows 10
or macOS claim: OS maintenance, browser HLS support and device codec all need validation.
Adding an MSE HLS player requires a separately reviewed dependency/UI change.

Saad must supply the device model/photo, channel and codec configuration. The staging
owner must verify private routing, TLS, reader restrictions, physical live frames, expiry
and revoke behavior, and browser playback on the approved revision. Do not call fixtures
hardware completion. Source comparison confirms credential-key wiring from `e7749967`
already exists in the assigned base despite different ancestry: secure Bicep parameter,
vault secret, runtime reference, container environment and dependency, staging export,
all three parameter files and `.env.example`. No infra reconciliation is required.

To disable, select `CAMERA_GATEWAY_MODE=unavailable`; grants then fail closed. Reverting
this private camera-only commit requires no schema rollback. Configuration secrets must
remain outside Git and client bundles.

## Sources and local checks

MediaMTX's official [browser guide](https://mediamtx.org/docs/read/web-browsers) describes
HLS access and browser-player constraints. Its [configuration reference](https://mediamtx.org/docs/references/configuration-file)
defines HLS variants and source/authentication options. Verify the owner's installed version
against those options before provisioning. MediaMTX does not imply automatic transcoding.

Continuation read installed Next 16.2.12 bundled documentation at
`node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`.
The route retains existing async params and Request/Response contracts. Build remains pending.

Native fixtures are deliberately `.test.mts`, outside Vitest discovery. Run explicitly:

```sh
bun test src/lib/restaurant/cameras/mediamtx.protocol.test.mts src/lib/restaurant/cameras/mediamtx-runtime.test.mts src/lib/restaurant/cameras/mediamtx-route.test.mts
```

They exercise real loopback HTTP response framing, HLS manifests and media payload bytes,
plus mocked route identity/database boundaries. They do not prove TLS handshakes, RTSP,
codecs, database RLS, production browser behavior or physical frames. Existing Vitest
contract suites remain required once dependencies are available.

## Implementation evidence — September 5, 2026

Assigned checkout: `/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1357-hw-p0-implement-real-dvr-camera-gateway-behind-existing-secure-camera-contracts`.
Branch: `WHA-1357-hw-p0-implement-real-dvr-camera-gateway-behind-existing-secure-camera-contracts`.
Exact base/commit parent: `fe1e3e383c8b966cdb68669ba5366db00fe2320a`. Initial working tree clean.
Private final SHA is recorded in the issue completion comment (a commit cannot embed its own SHA).

Changed paths:

- `src/lib/restaurant/camera-gateway-runtime.ts`
- `src/lib/restaurant/cameras/mediamtx.ts`
- `src/lib/restaurant/cameras/mediamtx.protocol.test.mts`
- `src/lib/restaurant/cameras/mediamtx-runtime.test.mts`
- `src/lib/restaurant/cameras/mediamtx-route.test.mts`
- `src/app/api/restaurant/cameras/[cameraId]/stream/route.ts`
- `src/app/api/restaurant/cameras/[cameraId]/stream/route.test.ts`
- `src/server/routers/restaurant-cameras.ts`
- `industry-specific-docs/restaurants/cameras/002-configured-mediamtx.md`

Before: real runtime unavailable; proxy fetched database URLs directly and rewrote only
bare playlist lines. After: explicitly configured HTTPS HLS transport, private address
pinning, bounded reads, complete supported-reference rewriting, fresh authorization,
registered-camera diagnostics and explicit unsupported legacy operations. No schema change.

Executed checks:

- The `bun test` command above: **15 passed, 0 failed**, 3 files, exit 0. Initial protocol-only
  run: 8 passed, 0 failed. Fixtures use Bun 1.3.14 and loopback HTTP, not live devices.
- Scoped typecheck command below: final **exit 0**, no diagnostics. One intermediate
  failure: `TS2353: 'autoSelectFamily' does not exist in type 'RequestOptions'`. Removed
  that redundant option; `family: 4` still selects IPv4 and the lookup still pins the
  address. This was the single compiler correction. The 15-test result precedes that
  one-line removal; no test rerun after the final typecheck, respecting the bounded run budget.
- Prettier `--write` on all nine changed paths: exit 0. The only subsequent code change
  removed the option line above. This evidence section was appended afterward.
- `git diff --check`: exit 0 before final commit.
- `git merge-base --is-ancestor e7749967 HEAD`: exit 1; `git show --stat e7749967` confirmed
  seven infra/environment documentation paths, no camera implementation.

Exact scoped compiler invocation (existing local compiler, no package installation):

```sh
node '/Users/Saad/Downloads/Projects & Code/DevFathom hub/company-hub/node_modules/typescript/bin/tsc' --noEmit --strict --skipLibCheck --target ES2022 --module esnext --moduleResolution bundler --types node --typeRoots '/Users/Saad/Downloads/Projects & Code/DevFathom hub/company-hub/node_modules/@types' src/lib/restaurant/cameras/mediamtx.ts src/lib/restaurant/cameras/mediamtx.protocol.test.mts src/lib/restaurant/cameras/mediamtx-runtime.test.mts src/lib/restaurant/camera-gateway-runtime.ts
```

Exact formatter invocation:

```sh
node '/Users/Saad/Downloads/Projects & Code/DevFathom hub/company-hub/node_modules/prettier/bin/prettier.cjs' --write src/lib/restaurant/cameras/mediamtx.ts src/lib/restaurant/cameras/mediamtx.protocol.test.mts src/lib/restaurant/cameras/mediamtx-runtime.test.mts src/lib/restaurant/cameras/mediamtx-route.test.mts src/lib/restaurant/camera-gateway-runtime.ts 'src/app/api/restaurant/cameras/[cameraId]/stream/route.ts' 'src/app/api/restaurant/cameras/[cameraId]/stream/route.test.ts' src/server/routers/restaurant-cameras.ts industry-specific-docs/restaurants/cameras/002-configured-mediamtx.md
```

Historical first-pass pending groups (superseded below): **5** — actual Vitest suites, ESLint, dependency-complete
router/route typecheck plus Next build, independent review, and staging/hardware/browser
acceptance. Next/Vitest/ESLint are absent from the available dependency tree. No production
build, database/migration execution, app/browser service, deployment or physical acceptance
was attempted. No RLS claim is made from mocked database tests. Claude-Mem/graph/Ponytail
tools were unavailable; narrow local reads used, no tool repair or nested agent session.

Historical first-pass disposition (superseded below): blocked. Chief of Staff must supply dependency-complete validation and a
designated independent reviewer, and coordinate the infra ancestry discrepancy. Saad and
the staging/network owner must supply the target configuration and conduct gated physical
acceptance. The wizard diagnostic UI and broader browser player remain explicit gaps;
this private commit is not end-to-end hardware completion.

## Verification continuation — September 5, 2026

Start HEAD `773a1a8e9b4b85ca8a3ae08aba87055c9726513c`, parent/base
`fe1e3e383c8b966cdb68669ba5366db00fe2320a`; assigned branch unchanged, tree clean.
This continuation changes only this document. Prior 15 passing native fixtures reused;
runtime source unchanged, with the prior one-line compiler correction caveat above.

Absent local `node_modules` was safely symlinked to supplied WHA-1116 dependency store.
No packages installed or shared artifacts changed. Commands:

```sh
node node_modules/vitest/vitest.mjs run src/lib/restaurant/camera-gateway-runtime.test.ts src/lib/restaurant/camera-credentials.test.ts src/lib/restaurant/cameras.test.ts src/lib/restaurant/camera-schema.test.ts src/lib/restaurant/camera-gateway.test.ts src/server/routers/restaurant-cameras.test.ts 'src/app/api/restaurant/cameras/[cameraId]/stream/route.test.ts' --maxWorkers=1 --no-file-parallelism
node node_modules/eslint/bin/eslint.js src/lib/restaurant/camera-gateway-runtime.ts src/lib/restaurant/cameras/*.mts src/lib/restaurant/cameras/mediamtx.ts 'src/app/api/restaurant/cameras/[cameraId]/stream/route.ts' 'src/app/api/restaurant/cameras/[cameraId]/stream/route.test.ts' src/server/routers/restaurant-cameras.ts
node node_modules/prettier/bin/prettier.cjs --check src/lib/restaurant/camera-gateway-runtime.ts src/lib/restaurant/cameras/*.mts src/lib/restaurant/cameras/mediamtx.ts 'src/app/api/restaurant/cameras/[cameraId]/stream/route.ts' 'src/app/api/restaurant/cameras/[cameraId]/stream/route.test.ts' src/server/routers/restaurant-cameras.ts industry-specific-docs/restaurants/cameras/002-configured-mediamtx.md
node node_modules/typescript/bin/tsc --project "$PAPERCLIP_RUN_SCRATCH_DIR/camera-tsconfig.json"
```

Vitest: **23 passed, 0 failed, 1 skipped**, seven files, exit 0. Skip requires
`CAMERA_TEST_DATABASE_URL`; no database accessed. Router contract tests inspect source,
not runtime database behavior. ESLint and Prettier exit 0, no diagnostics. Final scoped
TypeScript exit 0, no diagnostics. Initial scratch config omitted existing auth declaration,
causing session-type diagnostics; adding `src/types/next-auth.d.ts` resolved them without
source changes.

Compiler reproduction: copy root tsconfig into run scratch; disable incremental, use
absolute checkout `baseUrl`, `@/*` and `node_modules/@types` typeRoots. Include absolute
paths to mediamtx transport, camera runtime, router, stream route and auth declaration;
clear exclude. Map `@/generated/prisma/*` to
`/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1350-env-ph-purge-provision-bounded-verification-prerequisites-for-regulatory-profile-repair/src/generated/prisma/*`.
Its schema was byte-equal before read-only type reuse. No generated client or fixture
environment changed; no credentials loaded.

Remaining verification groups: **4** — isolated camera DB/RLS test, production build,
independent review, staging/hardware/browser acceptance. No app/browser service, build,
migration, deployment or physical acceptance attempted. No RLS claim. Claude-Mem, graph
and Ponytail unavailable; narrow fallback without setup repair or nested sessions.

Current supervisor/board owns review and target handoff, replacing paused leadership.
Saad supplies confirmed model/channel/codec; staging/network owner supplies private TLS
gateway and approved revision for physical acceptance. Assignee resumes upon handoff.
Wizard diagnostic UI and broader browser player remain gaps. No hardware completion
claim. This documentation-only continuation requires no runtime rollback.
