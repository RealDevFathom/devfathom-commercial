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
16 MiB media limit, no compression, and at most sixteen concurrent reads per server
transport instance. The only redirect followed is MediaMTX's own same-path
`?cookieCheck=1` session step (DEV-1003, below). This is not a distributed per-user rate
limiter.

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

An optional `"vertical"` field (`"restaurant"` or `"pharmacy"`) names the product surface a
binding serves. Bindings without it remain restaurant-only, so existing restaurant
configuration is unchanged; pharmacy live view (DEV-740) requires `"vertical": "pharmacy"`. See
`industry-specific-docs/pharmacy/cameras/001-configured-gateway-live-view.md`.

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
failure in real mode. The real-mode wizard instead labels setup as owner-provisioned,
registers through the existing administrative contract and directs the operator to the
registered camera card's manual connection diagnostic. The unused RTSP port input is removed;
the gateway owner configures that port. Stored credentials do not provision the DVR. Recording,
retention usage, PTZ, audio and export are not implemented by this live transport.

## Supported relay versions, sessions and H.265 (DEV-1003)

Restaurant and pharmacy cameras share one relay client (`src/lib/cameras/mediamtx.ts`), so the
same rules apply to both. The full description, the version table and the reference relay
configuration live in
`industry-specific-docs/pharmacy/cameras/001-configured-gateway-live-view.md`, section
"Supported relay versions and reference configuration". In short:

- **Supported: MediaMTX v1.17.1 to v1.21.4.** Tested on 20 Nov 2026 against the official
  v1.17.1, v1.18.0 and v1.21.4 Linux release binaries with a synthetic H.264 and H.265 source.
  Newer releases are not yet checked.
- MediaMTX v1.18.0 and later answer the first playlist request with a `302` to the same path plus
  `?cookieCheck=1`, check the reader login there and then require the session secret on every
  later request (sessions close after 30 s idle). The app follows only that exact step, keeps the
  secret and the reader login on the server, and opens a new session once when the relay ends one.
  It never follows a redirect to another host, address, scheme, port or path, and never uses
  `hlsCDNSecret`, which turns the relay's login check off.
- **Check configured connection** reads the master and the first media playlist. A relay outside
  the supported range, or one that redirects anywhere else, reports `relay-unsupported`: "The
  camera relay answered in a way this app does not support. Supported: MediaMTX v1.17.1 to
  v1.21.4 with the reference configuration in the camera setup document." The other outcomes keep
  their meaning.
- The reference configuration sets `moq: false` (MediaMTX v1.19.0 and later open a MoQ server on
  extra ports by default; delete that line on v1.17.1 or v1.18.0) and `hlsVariant: fmp4`, which
  carries H.264 and H.265. With `mpegts`, MediaMTX refuses H.265 sources.
- **H.265 cameras.** Nothing is transcoded and nothing on the recorder is changed. The check reads
  the codec from the playlist and, for H.265, adds: "This camera sends H.265 (HEVC) video, which
  the app does not convert. Safari on Mac, iPhone and iPad plays it. Chrome and Edge play it only
  on computers with H.265 hardware decoding. Other browsers may show no picture." Live view shows a
  plain H.265 message instead of a black picture when the browser cannot decode it.

## Compatibility and acceptance gates

The console detects native HLS first, otherwise lazily loads pinned hls.js 1.7.2 for
MediaSource-capable browsers. Neither path guarantees codec or hardware compatibility.
Windows 98/Vista/7 cannot host this modern browser/Node application;
use a separate supported gateway host and viewing workstation. No universal Windows 10
or macOS claim: OS maintenance, browser HLS support and device codec all need validation.
The board authorized only the official hls.js dependency for this correction; no CDN scripts,
LiveKit substitution, WHEP transport, or other dependency upgrades were added.

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

## WHA-1363 correction pass — September 5, 2026

Correction parent: `977eed1eb3bb2a611ee139bf65592630b420b5d3`; original base unchanged.
Full review attachment `cf0af5b1-dab3-4a20-afbf-f9e9d58e7e2b` and board cancellation of
interaction `d669c322-64d7-48a4-8890-f6b9b0a03588` authorize this single pass for F1–F4.

- F1: any `recording` query, even empty or combined with a segment, returns 400 before
  upstream access. Real-mode recording RPC returns PRECONDITION_FAILED. Console explicitly
  labels recordings unsupported; it never substitutes live media. Real-mode retention
  directs the operator to the gateway host instead of implying app configuration applies there.
- F2: native-HLS feature detection, camera-only dynamic hls.js import for MSE, explicit
  unsupported browser/codec, loading, autoplay-interaction, timeout and media-error states.
  Destroy adapter, detach source and cancel timers on close/unmount, replacement or denial.
  No application recovery loop; manifest/playlist/fragment retry policies disabled. The
  library's worker is disabled; decoding/transmuxing behavior remains the official library's.
- F3: each open view issues a grant and renews 15 seconds before expiry, carrying the prior
  grant ID. Server rechecks enabled camera, active matching tenant/branch gateway and prior
  grant viewer/camera/tenant/expiry/revocation through the same admin procedure. Audit input
  is suppressed because renewal includes a grant ID. Server 60-second expiry is unchanged.
  Maximum 30 grants per open view (roughly 22.5 minutes with immediate responses); then
  operator must reopen. Authorization deadline 10 seconds, video-loading deadline 20 seconds.
  First denied/failed renewal stops; late responses cannot reopen closed views. Renewal
  reloads the playback source and may briefly interrupt playback; physical acceptance must
  evaluate that transition. Already delivered buffered frames cannot be recalled server-side.
- F4: real wizard bypasses the simulated pre-registration check, preserves registration
  inputs, explains separate gateway setup and handles errors locally. Registered cards expose
  manual diagnostics for missing bindings/credentials, authentication, reachability and stream
  support, with automatic query retries disabled. A readable manifest is not live-frame proof.

Dependency evidence: official registry `https://registry.npmjs.org/hls.js/latest` and
[official release v1.7.2](https://github.com/video-dev/hls.js/releases/tag/v1.7.2) agreed on
1.7.2, released September 2, 2026. Registry license Apache-2.0, zero runtime dependencies.
GitHub repository security-advisories API returned `[]`; registry bulk advisory request
for only `{"hls.js":["1.7.2"]}` returned `{}`. This is a point-in-time check, not a guarantee
of no vulnerabilities. Official registry tarball SHA-512 verified against lockfile integrity.
Package extracted only into run-owned private dependency directory, with read-only symlinks
to existing dependencies. No shared installation, lifecycle scripts or global installation.
Structural lock comparison after removing the two hls.js entries equals parent lock exactly.

Correction paths in addition to this document:

- `package.json`, `bun.lock`
- `src/app/api/restaurant/cameras/[cameraId]/stream/route.ts`
- `src/server/routers/restaurant-cameras.ts`
- `src/components/restaurant/restaurant-camera-wizard.tsx` and `.test.tsx`
- `src/components/restaurant/restaurant-cameras-console.tsx` and `.test.tsx`
- `src/components/restaurant/restaurant-camera-player.tsx` and `.test.tsx`
- `src/lib/restaurant/cameras/live-session.ts` and `.test.ts`
- `src/lib/restaurant/cameras/stream-grants.test.ts`
- `src/lib/restaurant/cameras/mediamtx-route.test.mts`

Executed correction checks:

```sh
node node_modules/vitest/vitest.mjs run src/components/restaurant/restaurant-camera-player.test.tsx src/components/restaurant/restaurant-camera-wizard.test.tsx src/components/restaurant/restaurant-cameras-console.test.tsx src/lib/restaurant/cameras/live-session.test.ts src/lib/restaurant/cameras/stream-grants.test.ts src/server/routers/restaurant-cameras.test.ts src/lib/restaurant/camera-gateway-runtime.test.ts src/lib/restaurant/camera-credentials.test.ts src/lib/restaurant/cameras.test.ts src/lib/restaurant/camera-gateway.test.ts 'src/app/api/restaurant/cameras/[cameraId]/stream/route.test.ts' --maxWorkers=1 --no-file-parallelism
bun test src/lib/restaurant/cameras/mediamtx.protocol.test.mts src/lib/restaurant/cameras/mediamtx-runtime.test.mts src/lib/restaurant/cameras/mediamtx-route.test.mts
node node_modules/typescript/bin/tsc --project "$PAPERCLIP_RUN_SCRATCH_DIR/camera-tsconfig.json"
node node_modules/eslint/bin/eslint.js src/components/restaurant/restaurant-camera-player*.tsx src/components/restaurant/restaurant-camera-wizard*.tsx src/components/restaurant/restaurant-cameras-console*.tsx src/lib/restaurant/cameras/live-session*.ts src/lib/restaurant/cameras/stream-grants.test.ts src/lib/restaurant/cameras/mediamtx-route.test.mts src/server/routers/restaurant-cameras.ts 'src/app/api/restaurant/cameras/[cameraId]/stream/route.ts'
```

Vitest **45 passed, 0 failed, 0 skipped**, 11 files; protocol **16 passed, 0 failed**,
three files. Unit fixtures mock the media adapter and router admin middleware/database;
they prove application decisions, not MSE decoding or database authorization. Initial
fixture imported an unrelated missing generated DB client; mocking unrelated preset and
terminal services isolated the intended router test. Initial lint prefer-const warning
resolved with explicit session holder. UI/runtime compiler passed; adding tests to the
scratch config also requires existing `vitest.setup.ts` for matcher declarations. No
source types weakened. Scratch config otherwise follows the earlier reproduction, adding
changed UI/lifecycle files and their tests to include. Final commands/results recorded in
the issue comment; no full workspace build or browser service was run. Final source/test
compiler exit 0 with no diagnostics; final scoped ESLint and Prettier check exit 0;
`git diff --check` exit 0. After adding renewal audit-input suppression, reran
`node node_modules/vitest/vitest.mjs run src/lib/restaurant/cameras/stream-grants.test.ts --maxWorkers=1 --no-file-parallelism`:
**4 passed, 0 failed**, exit 0; reran scoped compiler and router/test lint, both exit 0.

WHA-1363 independently passed camera schema **4/4** and credential-table RLS probes **3/3**
using a new isolated PostgreSQL cluster and NOSUPERUSER/NOBYPASSRLS runtime, then stopped it.
That review evidence closes the earlier skipped camera DB gate; no schema changed here.

Three verification groups remain: independent WHA-1363 correction review, production build,
and authorized staging physical/browser/Studio matrix. Studio tokens, SectionCard, Button,
Input and existing responsive grid reused; no new shell or palette. No screenshots or
375/768/1024/1440, theme, motion, keyboard, browser-console matrix claimed. Owner must verify
native Safari and supported Windows/macOS MSE browsers, actual frames, codec, renewal after
60 seconds, close/denial and recovery on the approved revision. Hardware configuration remains
pending; this correction does not answer the owner's hardware question. No gateway deployment,
device probe, secrets generation, push or merge. Rollback: unavailable mode remains fail-closed;
reverting this correction restores the reviewed usability defects, so do not activate real
transport on that older revision. Current supervisor and WHA-1363 own review re-entry.

## F3-R1 audit-boundary correction — September 5, 2026

Supervisor comment `757186e4-6044-4cfd-9169-39e92fe5af7a` authorizes this narrow additional
pass, including shared audit serialization and adjacent existing tests. Clean correction
parent `036debad81072badc79e7331fae20e2a84addf3e`, parent of that commit `977eed1e`;
assigned branch and original base unchanged. Only this document, `src/server/audit.ts`
and `src/server/trpc.test.ts` changed.

Caller trace: outer tRPC audit middleware captures raw input before guards and calls
`recordTrpcAudit` after success or failure. That capture point calls `toAuditJson` before
`recordAudit` sends a row to the tenant sink; the platform sink also serializes input.
The existing recursive key redaction now matches exactly `previousGrantId`, case-insensitively.
This covers early failures without resolver annotation. Denial auditing, ACL, middleware
order, ordinary grant fields and other metadata remain intact. No cross-user bypass was
demonstrated by the original finding; the correction prevents retaining this short-lived
viewer-bound identifier in serialized audit input.

Regression evidence uses the actual admin middleware, camera resolver and audit serializer,
with mocked authorization decisions and database write sinks. Entitlement, capability,
license and invalid-input denials all produce a FAILURE row containing `[REDACTED]` instead
of the synthetic identifier, while retaining actor, action, error code and ordinary metadata.
The camera prefix currently lacks a catalog license mapping, so the license test mounts
the same camera procedure under the existing licensed `projects` fixture prefix to exercise
the real outer license guard. This is explicit fixture coverage, not a changed license policy.
A fifth regression covers case-insensitive nested keys, retained ordinary grant metadata
and nonmutation of the caller's input. No audit DB was written and no RLS claim is added.

Checks from this checkout:

```sh
node node_modules/vitest/vitest.mjs run src/server/trpc.test.ts --maxWorkers=1 --no-file-parallelism
node --input-type=module -e 'import Hls from "hls.js"; if (Hls.version !== "1.7.2") throw new Error("Unexpected version"); console.log("Real hls.js ESM import:", Hls.version);'
bun build src/components/restaurant/restaurant-camera-player.tsx --target browser --splitting --outdir "$PAPERCLIP_RUN_SCRATCH_DIR/camera-browser-bundle"
node node_modules/typescript/bin/tsc --project "$PAPERCLIP_RUN_SCRATCH_DIR/camera-tsconfig.json"
node node_modules/eslint/bin/eslint.js src/server/audit.ts src/server/trpc.test.ts src/components/restaurant/restaurant-camera-player.tsx src/components/restaurant/restaurant-camera-wizard.tsx src/components/restaurant/restaurant-cameras-console.tsx src/server/routers/restaurant-cameras.ts 'src/app/api/restaurant/cameras/[cameraId]/stream/route.ts'
```

Adjacent tRPC suite: **119 passed, 0 failed, 0 skipped**, including five new regressions.
The original eleven-file camera command printed in the preceding section was run unchanged:
**45 passed, 0 failed, 0 skipped**, with the real pinned hls.js resolvable and no fake alias.
Existing player tests still mock media behavior; they do not prove decoding. Separate real
ESM import returned `1.7.2`; browser-target bundle resolved seven modules and produced a
59.40 KB player entry, 1.54 KB shared chunk and 1.24 MB lazy HLS chunk, exit 0. This proves
package import and bundling, not browser playback or a full Next candidate build.
Scoped compiler (audit/test plus existing camera UI/router/route, Next types, auth declaration
and Vitest setup) exit 0. Initial lint reported one unused test-helper parameter; replaced
it with a typed mock declaration. Final lint/format/diff results are in the delivery comment.

Real package provenance: downloaded exact official registry `hls.js/1.7.2` tarball, verified
SHA-512 against `bun.lock`, extracted only into run-owned private dependency storage. No
install scripts, global/shared writes or manifest changes. Existing dependency packages
were linked read-only, excluding writable Vite/cache directories. Reproducible private
reviewer access: attachment `e455eada-b7d0-4995-89d1-af096a6fa45a`, filename `hls.js-1.7.2.tgz`,
8,003,699 bytes, SHA-256 `14311c46a7aea04a7ffc373653b11d019bb41df8a693a2459eb3115a262aef53`.
Download `/api/attachments/e455eada-b7d0-4995-89d1-af096a6fa45a/content`, verify its SHA-512
against the lock entry, extract in the reviewer's private scratch and link `hls.js` to its
`package` directory. This preserves true dependency access after implementation run cleanup.
The archive includes the upstream license. No placeholder module or CDN is required.

Unchanged protocol 16/16 and independent camera DB 4/4 plus credential isolation 3/3 evidence
are reused, not rerun. Three gates remain: original-review F3-R1 recheck, full candidate
build at composition, and authorized hardware/browser/Studio acceptance. No code here answers
model/codec/gateway or policy questions; no services, device probes, migration, deployment,
push or merge. Rollback of this narrow commit reintroduces audit retention of prior grant
IDs; unavailable gateway mode remains the operational fail-closed setting.
