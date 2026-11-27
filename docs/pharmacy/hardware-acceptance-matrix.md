# Pharmacy hardware setup and physical acceptance matrix (DEV-744)

> **Status: NO PHYSICAL ACCEPTANCE HAS BEEN PERFORMED.** Every device row below is
> `UNTESTED`. This document is a plan, a capability snapshot and a blocker list. It
> contains no pass result for any real device, and nothing in it may be quoted as
> evidence that a camera, printer, scanner or card terminal works with DevFathom.

- Linear: DEV-744 (GitHub mirror #1402). Scope is documentation and automated guards only.
- Code snapshot: `develop` at `11660b3`. Every code reference is to that commit.
- Written from a cloud session. No device, DVR, network, credential or payment was touched.
- Owners of the implementation work this plan depends on: DEV-740, DEV-741, DEV-742,
  DEV-743, DEV-745. This document describes their current state; it does not do their work.
- Guard test: `tests/pharmacy-hardware-acceptance-matrix.test.ts` (document contract) and
  `tests/pharmacy-hardware-capability-claims.test.ts` (code facts this document relies on).

## 1. Reading this document

### 1.1 Evidence class — what kind of thing a feature is

Every capability is labelled with exactly one class. Never mix them in a status report.

| Class | Meaning | Proves a physical device works? |
| --- | --- | --- |
| `REAL-INTEGRATION` | Code in this repository talks to the device or its gateway over a network or OS interface. | Only after a recorded physical test. Code existing is not a pass. |
| `SIMULATOR` | A test or dev double stands in for the device. | No. |
| `GENERATED-FILE` | The app produces bytes or HTML (ESC/POS, print HTML). Nothing confirms delivery or paper. | No. |
| `BROWSER-OS-DIALOG` | The app opens the browser/OS print dialog. The operator picks the printer. | No. A dialog is not paper. |
| `MANUAL-TENDER` | A human records a payment made elsewhere. No machine talks to the terminal. | No. It proves nothing about any terminal. |
| `NOT-IMPLEMENTED` | No code path exists on `develop`. | n/a |

### 1.2 Status values used in tables

`UNTESTED` (default, and the only value any device row may carry today),
`BLOCKED` (cannot start; the blocker is named), `NOT-IMPLEMENTED`,
`PASS` and `FAIL` (reserved for a future signed evidence pack, section 9; not used here).

### 1.3 Authorization gates

Do **not** start a physical test, change DVR settings, install anything locally, use a
real card or wallet, or put credentials into chat, a ticket or a file until the owner
(Saad) has approved that specific test in writing. Section 8 lists the stop conditions.

## 2. What exists today — capability snapshot

### 2.1 Summary

| Device class | What `develop` has | Evidence class | Physical acceptance |
| --- | --- | --- | --- |
| DVR / cameras (live view) | Pharmacy live view through the shared MediaMTX HLS gateway (DEV-740): configured-gateway registration, diagnostics, short-lived grants and a per-request authorized stream route. Relay client tested against the real MediaMTX v1.17.1, v1.18.0 and v1.21.4 release binaries with a synthetic H.264/H.265 source (DEV-1003); supported range MediaMTX v1.17.1 to v1.21.4. No DVR or browser playback test yet. | `REAL-INTEGRATION` code (Pharmacy and Restaurant) | UNTESTED on hardware; needs a connected camera and an owner-provisioned gateway |
| Camera still snapshots (transaction / cold-chain evidence) | Evidence capture works against the simulator. Real DVR snapshots are not wired. | `SIMULATOR` | UNTESTED, BLOCKED by DEV-745 |
| Thermal 58 / 80 mm — raw ESC/POS | The counter sends a settled receipt to a branch print queue; an enrolled print bridge (Pharmacy > Printer settings, administrators) collects it and reports QUEUED, SENDING, SENT_TO_PRINTER, FAILED, UNCONFIRMED or EXPIRED. Retry after FAILED or UNCONFIRMED needs a paper check. `SENT_TO_PRINTER` means the printer accepted the bytes, never that paper came out (DEV-741, DEV-904). | `REAL-INTEGRATION` code | UNTESTED on hardware; needs an enrolled bridge and owner approval (#1698) |
| Thermal 58 / 80 mm and A4 — browser | Receipt HTML opened in a popup, then `window.print()`. Format choice is not saved. | `BROWSER-OS-DIALOG` | UNTESTED, saved settings BLOCKED by DEV-742 |
| Barcode / DataMatrix scanner | Scanners are treated as keyboard input. GS1 parsing, goods-in resolution and pack authentication exist. No scanner-specific code. | Keyboard input into `REAL-INTEGRATION`-free parsing code | UNTESTED, config prerequisites below |
| Card terminal | Card and wallet tenders either use a manual "received externally" record or hit an uncertified-provider refusal. No provider is bound. | `MANUAL-TENDER` (manual); `NOT-IMPLEMENTED` (integrated) | UNTESTED, BLOCKED by DEV-743 |
| Shelf / price labels | Not covered here. DEV-90. The 50 x 30 mm dispensing label is a separate browser print. | n/a | not in scope |
| Cold-chain sensors | No sensor table or ingest route found by repository search at this snapshot. DEV-82. | `NOT-IMPLEMENTED` | not in scope |

### 2.2 Cameras — code facts

- Vendor-neutral contract is HLS-only: browsers never speak RTSP; a gateway would
  (`src/lib/cameras/contract.ts`).
- Brand presets are form-fill hints, explicitly "not verified facts"
  (`src/lib/cameras/presets.ts`, `contract.ts`). Families: Hikvision/EZVIZ, Dahua/IMOU,
  CP Plus, Uniview, TP-Link Tapo/VIGI, Manual.
- **DVR identification.** The user first described the DVR as "Al Hua". DEV-744 now records
  that Saad's label photo identifies it as a **Dahua Technology DH-XVR1B16-I, V2** DVR. That is
  an identification from a photo, nothing more. Dahua's published V2 specifications list RTSP,
  ONVIF and H.264/H.265, but a datasheet is not proof that this unit, its firmware and its
  settings work with DevFathom. Firmware, enabled protocols, channel streams and codec must be
  read from the actual device (section 4.1) before any compatibility is claimed. The repository's
  `dahua-imou` preset is a form-fill hint only. No serial number or credential is recorded.
- **Current test situation.** The DVR holds old recordings and has **no camera connected**.
  Those recordings must not be modified or deleted by any test. A temporary iPhone is the
  planned stand-in camera (section 5.1b); the planning is confirmed, no test has happened.
- Gateway modes: `unavailable` (default), `simulated` (refused unless `NODE_ENV` is
  development or test), `mediamtx` (`src/lib/cameras/camera-gateway-runtime.ts`).
  In `mediamtx` mode every legacy adapter method deliberately throws "unsupported"
  because those methods have no tenant or branch scope.
- Pharmacy router (`src/server/routers/pharmacy-cameras.ts`): all admin procedures use the
  `adminProcedure` base plus the `pharmacy-core` entitlement and organization match. In the
  simulator, `sourceRef` is still restricted to `sim-camera-1 | sim-counter-1 | sim-fridge-1`.
  In `mediamtx` mode (DEV-740), `enrollGateway` takes an exact `https://hostname/` URL,
  `register` takes a gateway stream path and refuses DVR credentials, cameras start disabled,
  and every camera-bound procedure also requires the pharmacy vertical, no platform support
  session, and branch access (session ADMIN or an active branch assignment).
  `configuredConnectionDiagnostics` reports a fixed outcome code only.
  `issueLiveViewGrant` issues 55 s grants, and
  `src/app/api/pharmacy/cameras/[cameraId]/stream/route.ts` re-authorizes every manifest and
  segment request. See `industry-specific-docs/pharmacy/cameras/001-configured-gateway-live-view.md`.
  **This is code, not a hardware pass.**
- Restaurant has the hardened MediaMTX transport and a stream route
  (`src/lib/cameras/mediamtx.ts`, `src/app/api/restaurant/cameras/[cameraId]/stream/route.ts`):
  HTTPS-only base URL, per-camera bindings, flat resource names, 256 KiB manifest cap,
  16 MiB segment cap, 10 s deadline. Pharmacy reuses the same transport; bindings carry
  `"vertical": "pharmacy"`, and bindings without it stay restaurant-only. This is code, not a
  hardware pass.
- **Relay versions (DEV-1003).** Supported: MediaMTX **v1.17.1 to v1.21.4**. MediaMTX v1.18.0
  and later use HLS sessions (a same-path `302` to `?cookieCheck=1`, then a session secret on
  every request, closed after 30 s idle). The client follows only that exact step, keeps the
  secret on the server and renews it, and reports `relay-unsupported` for anything else. The
  owner's relay, v1.21.4 from Homebrew, answered the old client with that `302`, which the app
  then showed as "gateway unreachable". Use the reference relay configuration in
  `industry-specific-docs/pharmacy/cameras/001-configured-gateway-live-view.md` (`moq: false`,
  `hlsVariant: fmp4`, no `hlsCDNSecret`). Integration test:
  `src/lib/cameras/mediamtx.relay.integration.test.ts` (needs `MEDIAMTX_BINARY`).
- Evidence snapshots: `evidenceSnapshotAdapter` returns an adapter only for the simulator
  runtime and `null` otherwise, so real snapshots fail closed
  (`src/lib/cameras/evidence.ts`). HLS playback does not provide a still. Real snapshot support
  depends on the DVR exposing one; that is undocumented for this unit (section 4.1).

### 2.3 Printing — code facts

- **Raw job** (`GENERATED-FILE`): `GET /api/pharmacy/print` calls
  `pharmacySales.counterReceiptPrintJob` and returns `ESC_POS_JOB` JSON containing base64
  bytes (`src/app/api/pharmacy/print/route.ts`, `src/lib/pharmacy/receipt-print.ts`).
  Its own header states it "queues nothing and cannot confirm paper". The browser
  receives bytes only; there is no dispatch to a printer.
- ESC/POS baseline (`src/lib/restaurant/printing/esc-pos.ts`): initialise (`ESC @`), left
  align, plain text, three feed lines, **full cut** (`GS V 0`). Text must be printable
  ASCII (0x20-0x7E) plus newline; anything else throws `UNSUPPORTED_PRINT_TEXT`. There is no
  code-page selection, no raster/bitmap path and no printer-status query.
- Width: 58 mm wraps at 32 columns and 80 mm at 48 columns
  (`src/lib/receipts/preview.ts`). These are the repository's assumptions. Real printers
  differ (dot width, font, margin), so the column count must be confirmed with a ruler
  line on the physical unit (HW-PRN-04).
- **Urdu and any non-ASCII text on the raw path:** refused; the API answers HTTP 422 with
  `fallback: BROWSER_OS`, and the UI falls back to the browser receipt
  (`receipt-print.ts`: "Urdu stays on the browser path"). Urdu on a thermal printer
  therefore depends entirely on the OS print driver and an installed Urdu font. Untested.
- **Reprint:** `reprint` is a query parameter supplied by the caller. The marker line
  ("REPRINT - not a new sale") appears only when the caller asks for it. Whether a caller can
  fetch unmarked repeat copies is the subject of DEV-195; not resolved by this document.
  The route runs under an audited procedure; this document did not verify what is recorded.
- **Bridge:** the Restaurant `scripts/print-bridge.ts` + `src/lib/restaurant/printing/target.ts`
  resolve only explicit targets: `tcp://host:9100`, `queue:///name` (macOS or Windows),
  or a POSIX `/dev/` character device. Pharmacy uses the same script with a `ppb_`
  credential: an administrator enrols a bridge for one branch under Pharmacy > Printer
  settings, the credential is shown once, and the bridge reports delivery states to the
  Pharmacy print queue (DEV-741 server, DEV-904 screens). The script accepts only an `https`
  application address, so it cannot run against a local `http://localhost` copy.
- **Browser path** (`BROWSER-OS-DIALOG`): `src/lib/pharmacy/counter-browser-print.ts`
  opens a popup (`window.open`), writes escaped HTML and calls `print()`. Formats: `THERMAL`
  (80 mm), `THERMAL_58`, `A4` (190 mm body, 10 mm margin), `LABEL_50x30`. A blocked pop-up
  produces "Allow pop-ups for this site, then retry". The font is the browser's `monospace`;
  Urdu rendering depends on installed fonts. Cancelling the dialog cannot be told apart
  from printing; the app never claims paper output. The chosen format is **session-only**.
  Saved branch layout exists server-side but has no Pharmacy settings screen (DEV-742).
- Older Windows (98/Vista/7) cannot host this modern browser/Node application; use a
  maintained host and a vendor-supported driver or an approved bridge
  (`src/lib/pharmacy/COUNTER-PRINTING.md`).

### 2.4 Scanners — code facts

- No scanner driver or Web-HID/Serial code exists. A scanner is assumed to be a **keyboard
  wedge**: it types the code followed by Enter into the focused field. Scanners in
  serial/USB-CDC/HID-POS mode are not supported by the app and are untested.
- Counter: `src/components/pharmacy/counter/counter-console.tsx`. On Enter, a value is
  handled as a barcode when it is 6+ digits only, or starts with `]d2` or `(01)`; anything
  else goes to name search. For the GS1 route (`runSearch`) only text starting with `]d2` or
  `(01)` is sent to pack authentication. **Consequence to verify on hardware:** a scanner
  that sends the raw element string (starting `01...` with letters in the batch, no AIM
  prefix) would be treated as free-text search at the counter, not as a DataMatrix scan.
  The scanner must be configured to send the AIM symbology identifier, or the counter rule
  needs a change; that change belongs to DEV-92 / DEV-575, not this issue.
- Parser `src/lib/pharmacy/gs1-datamatrix.ts` accepts `]d2`, `]C1`, `]Q3` prefixes, and
  group separators written as GS (0x1D), `<GS>`, `|` or `~`. It rejects a variable-length
  field that runs into the next field without a separator. A wedge that **drops the 0x1D**
  character can therefore yield a rejected or ambiguous code. Whether a given scanner emits,
  swaps or drops GS is a hardware setting to record (HW-SCN-03).
- **Observed parser limitation (reported to DEV-92, not fixed here).** On `develop` at
  `11660b3`, the last variable-length element of a scan is rejected as "not terminated before the
  next AI" when its tail looks like another GS1 element, even though the final element
  legitimately has no trailing GS. Reproduction (synthetic data, GS = byte 0x1D):
  `]d2` + `01` + `08961234567894` + `17270430` + `10B2201` + GS + `21` + a serial such as
  `123456789012`, `100000000001` or `SN12345678` -> `invalid`; the serial `A3F09C1E77B2`
  from the existing fixtures -> `parsed`. Numeric serials are common on real packs, so a real
  scanner could hit this. At the counter an unparsed verdict is advisory, but the search then
  falls back to the raw text; at goods-in the scan is unresolved. Not pinned by a test so the
  owner of DEV-92 can fix it without fighting a characterization test. Recheck before relying on it.
- Goods-in (`receiving/page.tsx` + `pharmacyPurchasing.resolveScan`) is a plain GET form that
  searches on Enter only; live search is DEV-734.
- Duplicate scans at the counter: an in-flight guard suppresses the same text while a scan is
  live (`scannerInFlight`, `scannerRevision`). Pack-level duplicate-serial detection is
  `DUPLICATE_SERIAL`, organisation-scoped, and **advisory** except for recalled batches
  (`src/lib/pharmacy/pack-authentication.ts`). Primary-pack serial blocking is DEV-92.
- Scan-to-cart speed and 50 rapid scans are DEV-575 acceptance; measure there, not here.

### 2.5 Card terminals — code facts

- `CARD` and `WALLET` tenders call the payment adapter; without one, or with an
  uncertified one, settlement throws `UNCERTIFIED_PROVIDER`
  (`src/lib/pharmacy/settlement.ts`: `requireReleaseSafeAdapter`, `settle`). A `MOCK`
  adapter is refused in production (`MOCK_PROVIDER_IN_RELEASE`). **No provider or terminal is
  bound; no card integration is certified.**
- Manual tenders `RAAST`, `JAZZCASH`, `EASYPAISA` record a reference for a payment made
  elsewhere (`src/lib/pharmacy/manual-payments.ts`, `MANUAL_TENDER_TYPES`). A manual
  "card received externally" tender is DEV-713 (PR #1363, in review). Both are `MANUAL-TENDER`:
  they say nothing about any terminal and must never be reported as terminal integration.
- DEV-743 owns the provider-agnostic adapter seam (`src/lib/pharmacy/card-terminal/`, design in
  `docs/pharmacy/card-terminal-integration-boundary.md`). It commits one durable payment-attempt
  record (`pharmacy_card_terminal_attempts`) before a terminal can be asked to charge. Its
  production admission list is empty and only a fake test terminal exists, so the integrated row
  stays `NOT-IMPLEMENTED` until a named provider passes a real-device test. No provider, SDK or
  certification may be assumed. Card numbers (PAN) and CVV must never be stored or logged.

## 3. Dependencies and owners (Linear state read on 2026-11-04)

| Issue | Role for DEV-744 | State | Do not duplicate |
| --- | --- | --- | --- |
| DEV-740 | Real DVR live viewing via shared gateway | Code merged (2026-11-06); hardware acceptance pending | Gateway registration, grants, player |
| DEV-741 | Thermal transport, job ack, retry, dedupe | Backlog | Bridge, queue, delivery status |
| DEV-742 | Printer settings and test print (thermal + A4) | Backlog | Saved format UI, test print |
| DEV-743 | Provider-agnostic terminal seam | Backlog | Adapter, pending/timeout, refund/void |
| DEV-745 | Real snapshots for transaction / cold-chain | Backlog | DVR snapshot transport |
| DEV-92 | Primary-pack DataMatrix verify/harden | In Progress | Serial-level sale blocking |
| DEV-575 | Counter scan/search speed | In Review (PR #1382) | Scan latency, burst detection |
| DEV-734 | Goods-in scan/search live search | In Progress | Search-as-you-type |
| DEV-713 | Manual received-externally tenders | In Review (PR #1363) | Manual card/wallet tender |
| DEV-90 | Shelf/price sticker printing | In Review | Label design/print |
| DEV-636 | Receipt content (address, licence, cashier) | In Review (PR #1378) | Receipt wording and fields |
| DEV-82 | Live cold-chain sensor push | In Review | Sensor ingest |

States change. Recheck Linear before relying on this table. No DEV-744 branch or PR
existed before this change (preflight: open PR list and remote branches searched). The
`cloud/issue-7xx` branches on the remote have no merge base with `develop` and belong
to an older numbering scheme; they are unrelated to this issue.

## 4. Information needed before any physical test

Provide these in the evidence pack (section 9). Never include passwords, tokens, RTSP URLs
with credentials, card numbers, or public IP addresses.

### 4.1 DVR and cameras

| Item | Value | Source |
| --- | --- | --- |
| Exact model suffix and hardware version on the unit | _from photo, to confirm_ | label / device web UI |
| Brand and model | Dahua Technology DH-XVR1B16-I, V2 (from label photo; unverified on device) | label photo |
| Firmware version and build date | _unknown_ | device web UI |
| Channel count and which channel is counter / fridge | _unknown_ | operator |
| Video codec (H.264 / H.265 / other) | _unknown_ | device web UI |
| Stream profiles (main/sub), resolution, bitrate | _unknown_ | device web UI |
| ONVIF support and version; RTSP enabled | _unknown_ | device web UI |
| Does the DVR offer a still-image (snapshot) request? | _unknown_ | vendor docs, not assumed |
| Recording retention on the DVR | _unknown_ | operator |
| DVR LAN segment, who may reach it, gateway host location | _unknown_ | operator |
| Dedicated read-only viewer account exists (name only, no password) | _unknown_ | operator |

H.265 matters: browsers often cannot play HEVC HLS. The owner decided (20 Nov 2026) not to
change anything on the DVR, and nothing is transcoded. The relay must use `hlsVariant: fmp4`
(MPEG-TS carries H.264 only). The app reads the codec from the playlist: for H.265, **Check
configured connection** says that Safari on Mac, iPhone and iPad plays it, and Chrome and Edge
only on computers with H.265 hardware decoding. Live view then shows a plain H.265 message, not a
black picture, when the browser cannot decode it. Owner's channel 6 sub stream is H.265
(20 Nov 2026 test); browser playback is untested.

### 4.2 Printers (one row per printer)

Make/model, interface (USB, LAN, Bluetooth, serial), paper (58 mm, 80 mm, A4, roll
diameter), cutter yes/no, print width in dots, character code pages, driver name and
version, host OS and version, whether the OS shows a named queue, and whether the vendor
publishes an ESC/POS command reference. Never test with an unknown shared printer.

Printers named so far (planning details from DEV-744, nothing verified on a device):

| Role | Printer | Known | Unknown |
| --- | --- | --- | --- |
| A4 | Canon PIXMA G3416 (user-confirmed) | Model name only | Host OS, driver, connection used (USB / Wi-Fi), browser |
| Thermal | Possibly an Epson thermal printer | Nothing reliable | Exact model, paper width, interface(s), cutter, code pages, driver. **Do not assume ESC/POS or any Epson-specific compatibility.** |

Priority set by the owner on 2026-11-04: **USB thermal printing first.** Network and Bluetooth
thermal printers used by other pharmacies stay a planned path, not a supported or tested one.
Standard A4 printing must keep working. The Canon A4 test is planned separately from, and does
not depend on, the later USB thermal test.

### 4.3 Scanners (one row per scanner)

Make/model, firmware, interface mode (USB-HID keyboard wedge, USB-CDC serial, Bluetooth
HID, other), symbologies enabled (EAN-13, Code128, GS1 DataMatrix, GS1-128), AIM identifier
on/off, GS (0x1D) handling (sent / replaced / dropped), suffix (Enter / Tab / none),
keyboard layout and host OS layout, 1D versus 2D imager.

### 4.4 Card terminals

Make/model, acquirer, supported integration (standalone, ECR/serial, cloud API, SDK),
whether the acquirer or vendor documents an integration protocol, and certification
status as stated by the vendor in writing. Do not infer any of these. No live
transactions without separate written approval and a test merchant arrangement.

### 4.5 Client environment (record for every test run)

Browser and version, operating system and version, device (desktop/tablet), screen size,
network (same LAN / VPN / cellular), app build (git SHA and deploy), signed-in user and
role, branch. Supported-browser policy for hardware features is not defined in the repo;
record what you used rather than assuming.

## 5. Test matrices

Every row is `UNTESTED`. "Evidence" is what must be attached before a row may become
`PASS` (see section 9). Rows marked `[BLOCKED: DEV-xxx]` cannot start until that work is
delivered and deployed to the test environment.

### 5.1 Cameras and DVR

| ID | Check | Method | Expected | Evidence | Prerequisite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| HW-CAM-01 | Identify the DVR exactly | Read label and device UI | Model, firmware, channels, codec recorded | Photo of label (no serial if sensitive), screenshot of info page | Operator access | UNTESTED |
| HW-CAM-02 | Read-only account exists and is least-privilege | Review device user list | Dedicated account, no admin | Screenshot with names only | Operator | UNTESTED |
| HW-CAM-03 | Gateway reaches DVR on the private network only | Gateway-side diagnostic (DEV-740) | `ok` / `auth-failed` / `unreachable` only; no topology detail | Probe result record | DEV-740 code merged; needs connected camera and owner-provisioned gateway | UNTESTED |
| HW-CAM-04 | Live view of one channel in the supported browser | Open Pharmacy camera view | Video plays; no RTSP URL, host or password in page source, network tab, console or logs | Screen capture, HAR with secrets scrubbed | DEV-740 code merged; needs connected camera and owner-provisioned gateway | UNTESTED |
| HW-CAM-05 | Codec compatibility (H.264 and, if used, H.265) | Play main and sub stream in each browser; record the relay version (`mediamtx --version`, supported v1.17.1 to v1.21.4) | Plays, or the H.265 line and message name the browsers that play it | Capture per codec | DEV-740 code merged; needs connected camera and owner-provisioned gateway | UNTESTED |
| HW-CAM-06 | Role access: admin allowed; cashier / pharmacist / read-only denied | Sign in as each role | Allowed roles only | Per-role result | DEV-740 code merged; needs connected camera and owner-provisioned gateway | UNTESTED |
| HW-CAM-07 | Branch isolation: branch A user cannot view branch B | Sign in as A, request B camera | Denied | Result + audit entry | DEV-740 code merged; needs connected camera and owner-provisioned gateway | UNTESTED |
| HW-CAM-08 | Viewer grant expiry and revocation | Revoke / wait for expiry while playing | Playback stops; reuse refused | Timestamps | DEV-740 code merged; needs connected camera and owner-provisioned gateway | UNTESTED |
| HW-CAM-09 | Failure: DVR unplugged / wrong credential / gateway down | Controlled fault at the DVR with owner approval | Honest error; no secret leak; recovery after restore | Before/after captures | DEV-740 code merged; needs connected camera, owner-provisioned gateway and owner approval | UNTESTED |
| HW-CAM-10 | Still snapshot for a tender or cold-chain event | Trigger evidence capture | Image stored privately; failure shows `SNAPSHOT_UNAVAILABLE`, not a fake image | Stored object metadata, no pixels in ticket | [BLOCKED: DEV-745] | UNTESTED |
| HW-CAM-11 | Retention purge of evidence stills | Wait for or simulate retention | Removed per policy | Purge record | [BLOCKED: DEV-745] | UNTESTED |
| HW-CAM-12 | Privacy: consent / signage / who may view | Policy check | Documented per branch | Policy note | Owner | UNTESTED |

### 5.1b Optional iPhone stand-in camera (planned, not performed)

The test phone is an **iPhone** (user-confirmed). This confirms the planned device only. No test
has been run, no app has been installed, no camera permission granted and no network touched.
This is a separate test from the DVR: it needs no DVR and must never write to the DVR or its
recordings. Whether an iPhone app can publish RTSP to an owner-controlled gateway, and whether
any such app is compatible with the gateway or with ONVIF on the DVR, is **unverified**.

| ID | Check | Method | Expected | Evidence | Prerequisite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| HW-PHN-01 | Approve the test plan | Owner written approval naming the iPhone, the app, the gateway host and the network | Approval recorded before anything else | Approval note | Owner | UNTESTED |
| HW-PHN-02 | Pick a publisher app and record name and version | Owner chooses; review its permissions and data handling | App identity recorded; no account credentials in chat | Sheet | Owner approval; no install without approval | UNTESTED |
| HW-PHN-03 | Owner-controlled gateway accepts a publish on a private network | Publisher to gateway; no ports opened to the internet | Stream appears at the gateway only | Gateway-side status, no URLs with credentials | Owner gateway; HW-PHN-01 | UNTESTED |
| HW-PHN-04 | Live view through the app's gateway path | Open the Pharmacy camera view | Plays, with no RTSP URL or credential in page, network tab or logs | Capture | DEV-740 code merged; needs the authorized phone feed and an owner-provisioned gateway | UNTESTED |
| HW-PHN-05 | Codec and orientation | Record codec and rotation used by the app | Plays or fails honestly | Capture | HW-PHN-03 | UNTESTED |
| HW-PHN-06 | Interruption and recovery | Lock the phone, switch app, drop Wi-Fi, restore | Honest status; resumes or fails clearly | Timestamps | HW-PHN-03 | UNTESTED |
| HW-PHN-07 | Privacy | Point only at an agreed, non-patient scene | No patient or customer in frame | Test note | Owner | UNTESTED |
| HW-PHN-08 | Phone to DVR via ONVIF (optional, separate) | Only if the owner approves and the app supports it | Treated as unverified until shown | Device list screenshot | Owner approval; no DVR change without it | UNTESTED |
| HW-PHN-09 | Teardown | Stop publishing, revoke camera permission, remove any temporary gateway binding | Nothing left running or exposed | Checklist | HW-PHN-01 | UNTESTED |

A pass here would show only that this phone, app and gateway work together in this setup. It would
not show that a CCTV camera, the DVR or its firmware work.

### 5.2a Printer connection plan and order (planned, none performed)

| Order | Track | Why | Status |
| --- | --- | --- | --- |
| 1 | USB thermal (printer model to be identified) | Owner priority | UNTESTED, planned |
| 2 | Canon PIXMA G3416, A4, browser/OS dialog | Current A4 printer; independent of the thermal work | UNTESTED, planned |
| 3 | Network (LAN) thermal | Used by other pharmacies; path preserved | UNTESTED, planned option only, not scheduled |
| 4 | Bluetooth thermal | Used by other pharmacies; path preserved | UNTESTED, planned option only, not scheduled |

What the code supports at `11660b3`, so nobody assumes more:
- The app has **no** WebUSB, Web Serial or Web Bluetooth code. Browser printing can reach a USB
  printer only through an OS-installed queue and driver. Bluetooth works the same way, only if the
  OS pairs the printer and exposes a queue. Which OS and browser can do that is unverified.
- The raw ESC/POS receipt is dispatched through an enrolled print bridge (DEV-741, DEV-904). The bridge parser accepts
  `tcp://host:9100`, `queue:///name` (macOS/Windows) and POSIX `/dev/` character devices
  (`src/lib/restaurant/printing/target.ts`). A USB printer would reach the bridge as an OS queue
  or a `/dev/` device, a LAN printer as `tcp://`. **There is no Bluetooth target form.**
  This is bridge parsing only; the bridge has not been run against a real printer.
- Compatibility of any printer, OS, browser, driver or connection type is **unverified** until a
  user-authorized real test records an evidence pack (section 9).

| ID | Check | Method | Expected | Evidence | Prerequisite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| HW-USB-01 | Identify the thermal printer exactly | Read label and driver page; record model, paper width, cutter, interface | Complete section 4.2 row; Epson brand not assumed | Photo of label, driver page | Owner access | UNTESTED |
| HW-USB-02 | OS sees the USB printer and a named queue | Host OS printer list | Queue present with vendor driver | Screenshot | HW-USB-01; install only with approval | UNTESTED |
| HW-USB-03 | Browser dialog print, 80 mm or 58 mm to the USB queue | Counter -> Print receipt -> pick the queue | Correct width, no clipping | Photo of paper | HW-USB-02 | UNTESTED |
| HW-USB-04 | Raw ESC/POS over USB (queue or device) | Counter -> Send to thermal printer through an enrolled bridge | Prints; app shows an honest delivery state | Photo + app state | Enrolled bridge (Pharmacy > Printer settings); owner approval | UNTESTED |
| HW-USB-05 | Unplug, replug, sleep and wake the host | Disturb the connection | Visible error, safe retry, no duplicate paper | Capture | HW-USB-03 | UNTESTED |
| HW-A4-01 | Record the Canon PIXMA G3416 setup | Host OS, driver, connection, browser | Complete row | Sheet | Owner access | UNTESTED |
| HW-A4-02 | A4 receipt and Z-report to the Canon | Counter -> A4; Z-report | Fits page, 10 mm margins, readable | Photo of page | HW-A4-01 | UNTESTED |
| HW-A4-03 | Urdu text on A4 | Urdu locale print | Correct shaping, right-to-left | Photo | Urdu font on host | UNTESTED |
| HW-A4-04 | Cancel, retry, out-of-paper | Cancel the dialog; run out of paper | App never claims paper output | UI state | HW-A4-01 | UNTESTED |
| HW-NET-01 | LAN thermal printer (planned option) | Needs a static address on a private network and a vendor-documented raw port | Only after owner approval and DEV-741 | Pack | Not scheduled | UNTESTED |
| HW-BT-01 | Bluetooth thermal printer (planned option) | Needs OS pairing and a queue | Per-OS result recorded, not assumed | Pack | Not scheduled | UNTESTED |

The Canon rows never touch the thermal printer and run on their own approval. Do not change
printer settings, firmware or network configuration without separate written approval.

### 5.2 Thermal printers (58 / 80 mm) and A4 — raw and browser

Split by path so a browser pass is never reported as a raw-ESC/POS pass.

| ID | Check | Method | Expected | Evidence | Prerequisite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| HW-PRN-01 | Record printer identity, driver, OS queue | Section 4.2 sheet | Complete row | Sheet | Operator | UNTESTED |
| HW-PRN-02 | Browser print, 80 mm English cash receipt | Counter -> Print receipt -> choose the 80 mm queue | Whole receipt on 80 mm paper, no clipped columns | Photo of paper | OS queue + driver | UNTESTED |
| HW-PRN-03 | Browser print, 58 mm English cash receipt | Same with `THERMAL_58` | No clipping | Photo | 58 mm queue | UNTESTED |
| HW-PRN-04 | Raw-path column width | Print a 48-char and a 32-char ruler line | Ruler fits the stated width | Photo; note real columns | Enrolled bridge; no raw ruler page yet, use a receipt with a full-width line | UNTESTED |
| HW-PRN-05 | A4 receipt / report on a normal printer | Counter -> A4; Z-report | Fits page, 10 mm margins | Photo of page | A4 queue | UNTESTED |
| HW-PRN-06 | Urdu receipt, browser path | Switch locale to Urdu, print | Correct shaping, right-to-left, digits | Photo | Urdu font on host | UNTESTED |
| HW-PRN-07 | Urdu on raw path | Request Urdu job | Refused with browser fallback, no garbage | API result 422 + UI state | none | UNTESTED |
| HW-PRN-08 | Medicine names with non-ASCII characters | Print on both paths | Raw refuses; browser prints | Results | none | UNTESTED |
| HW-PRN-09 | Cutter and paper-out | Paper out / cover open | Honest app state; no silent success | Photo, UI state | Enrolled bridge; owner approval | UNTESTED |
| HW-PRN-10 | Cancel the OS dialog | Cancel | App must not claim paper was printed | UI state | none | UNTESTED |
| HW-PRN-11 | Pop-up blocked | Block pop-ups, print | "Allow pop-ups" guidance and retry works | UI state | none | UNTESTED |
| HW-PRN-12 | Duplicate-print protection | Double-click, retry after timeout, reload mid-print | One original; repeats are marked REPRINT; no new receipt number | Paper + audit | Enrolled bridge; [BLOCKED: DEV-195] for the reprint policy | UNTESTED |
| HW-PRN-13 | Reprint marking cannot be bypassed by editing the URL query | Call the print API with `reprint=0` for an old sale | Policy decided and enforced | Result | [BLOCKED: DEV-195] | UNTESTED |
| HW-PRN-14 | Role access: who may print / reprint | Each role | Matches policy | Per-role result | DEV-742 | UNTESTED |
| HW-PRN-15 | Receipt content correctness | Compare paper to sale | Totals, tender, batch/expiry correct; address/licence per DEV-636 | Photo + sale record | DEV-636 merged | UNTESTED |
| HW-PRN-16 | Saved paper format per branch | Set, reload, sign in elsewhere | Persisted, branch-scoped | Screens | [BLOCKED: DEV-742] | UNTESTED |
| HW-PRN-17 | Test print page | Press test print | Honest "sent" vs "printed" wording | Screens + paper | [BLOCKED: DEV-742] | UNTESTED |
| HW-PRN-18 | Connectivity loss | Unplug network/USB mid-job | Visible error, no loss of sale, retry works | Capture | [BLOCKED: DEV-741] | UNTESTED |
| HW-PRN-19 | 50 x 30 mm dispensing label | Print label | Fits label stock | Photo | Label printer queue | UNTESTED |

Shelf and price stickers are DEV-90 and are not tested here.

### 5.3 Barcode and DataMatrix scanners

| ID | Check | Method | Expected | Evidence | Prerequisite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| HW-SCN-01 | Record scanner identity and mode | Section 4.3 | Complete row | Sheet | Operator | UNTESTED |
| HW-SCN-02 | Keyboard test | Scan into a plain text field | Text + Enter, no layout corruption | Screen | none | UNTESTED |
| HW-SCN-03 | GS (0x1D) and AIM handling for GS1 DataMatrix | Scan a known GS1 pack in a text box | Record whether `]d2` is sent and whether GS is kept, replaced or dropped | Raw text capture | none | UNTESTED |
| HW-SCN-04 | EAN-13 legacy pack at the counter | Scan | Medicine added once | Cart | none | UNTESTED |
| HW-SCN-05 | GS1 DataMatrix at the counter | Scan | Pack authentication verdict shown; lot picked; only treated as GS1 if the counter rule is satisfied (section 2.4) | Screen + sale | DEV-92 / DEV-575 | UNTESTED |
| HW-SCN-06 | GS1 DataMatrix at goods-in | Scan at receiving | Lot created with batch/expiry/serial; end-of-month expiry warning shown | Screen | DEV-734 for live behaviour | UNTESTED |
| HW-SCN-07 | Primary-pack bottle/tube and GS1-128 carton | Scan each | Per DEV-92 acceptance | Screens | [BLOCKED: DEV-92] | UNTESTED |
| HW-SCN-08 | Duplicate scan protection | Scan same code twice quickly and after delay | Same-text in-flight scan ignored; later duplicate serial flagged | Cart + verdict | DEV-92 | UNTESTED |
| HW-SCN-09 | Burst speed | 50 rapid scans | No dropped digits; under 300 ms each | Timing log | [BLOCKED: DEV-575] | UNTESTED |
| HW-SCN-10 | Damaged / low-contrast / glare / blister-foil pack | Scan | Honest failure and manual fallback | Screens | none | UNTESTED |
| HW-SCN-11 | Keyboard layout mismatch | Scan with a non-US layout active | Detect and record corruption | Screen | none | UNTESTED |
| HW-SCN-12 | Focus loss mid-scan | Click away during scan | No partial item added | Cart | none | UNTESTED |
| HW-SCN-13 | Roles | Each role scans | Per permission model | Result | none | UNTESTED |
| HW-SCN-14 | Recalled batch | Scan a recalled test batch | Blocked with explanation | Screen | Test data only | UNTESTED |
| HW-SCN-15 | Pack whose serial is long or numeric | Scan a real or synthetic-printed pack with a 12+ digit numeric serial | Parsed, or an honest manual fallback (see parser limitation, section 2.4) | Raw text + screen | [BLOCKED: DEV-92] | UNTESTED |

### 5.4 Card terminals

| ID | Check | Method | Expected | Evidence | Prerequisite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| HW-PAY-01 | Identify terminal and vendor-stated integration options | Section 4.4 | Complete row; certification only as written by vendor | Vendor document reference | Owner | UNTESTED |
| HW-PAY-02 | Manual "received externally" card tender | Record a pretend reference with no live card | Reference and confirmer recorded; EOD reconciles by type | Screen + reconciliation | DEV-713 merged | UNTESTED |
| HW-PAY-03 | Integrated card attempt is honestly refused today | Try CARD tender without provider | Clear message; no pending charge; no fake approval | Screen | none | UNTESTED |
| HW-PAY-04 | Pending / timeout / recovery | Terminal approves after the app times out | Reconciles, no double sale or lost payment | Ledger | [BLOCKED: DEV-743] + live terminal | UNTESTED |
| HW-PAY-05 | Duplicate-charge protection | Retry same idempotency key | One charge | Terminal + ledger | [BLOCKED: DEV-743] | UNTESTED |
| HW-PAY-06 | Void / refund | Void then refund (test amounts, approved arrangement) | Correct ledger and terminal effect | Both records | [BLOCKED: DEV-743] | UNTESTED |
| HW-PAY-07 | No card data stored or logged | Search DB/log/audit output for PAN/CVV patterns after tests | None | Search result | [BLOCKED: DEV-743] | UNTESTED |
| HW-PAY-08 | Role access | Each role takes card tender | Matches policy | Result | DEV-713 / DEV-622 | UNTESTED |

No live financial transaction occurs without separate written approval.

## 6. Cross-cutting checks

### 6.1 OS and browser matrix (fill once, then reuse)

| Axis | Values to record | Status |
| --- | --- | --- |
| Operating system | Windows (10/11), macOS, ChromeOS, Android tablet, Linux | UNTESTED for all |
| Browser | Chrome/Edge, Safari, Firefox (versions) | UNTESTED for all |
| Print path | Browser dialog, raw ESC/POS | UNTESTED |
| Network | Same LAN, VPN, offline | UNTESTED |

Direct USB/serial/Bluetooth printing from the browser is not supported by the app (no WebUSB, Web Serial or Web Bluetooth code). A host with an
OS-visible queue and a working driver is the prerequisite for the browser path
(`COUNTER-PRINTING.md`).

### 6.2 Roles and access

Test each applicable role: owner/admin, pharmacist, cashier, read-only, a user from another
branch, a user from another tenant, a disabled user. Cameras require admin in the Pharmacy
router today; receipt print goes through branch and receipt-access checks in
`requireCounterReceiptAccess`. Record the actual result, not the expected one.

### 6.3 English, Urdu and paper handling

English prints on both paths. Urdu prints only through the browser/OS path and only if a font
is installed. Paper handling: confirm roll width, cutter, paper-out, jam, cover-open, and A4
tray; record what the app shows in each case.

### 6.4 Failure, retry and duplicate protection

For every device record: what the user sees, whether data is lost, whether a retry is safe,
whether a duplicate output or charge can occur, and what the audit trail records. Do not
claim a retry is safe without a test showing it.

## 7. Prioritised blockers

| Priority | Blocker | Why it matters | Owner |
| --- | --- | --- | --- |
| P0 | No real DVR path from Pharmacy; router refuses anything but the simulator | Camera acceptance cannot start | DEV-740 |
| P0 | No card terminal integration; card tender is manual or refused | Payment acceptance impossible; do not describe manual as integration | DEV-743, DEV-713 |
| P0 | Raw receipt job is never dispatched; no delivery status | Cannot say a thermal print happened | DEV-741 |
| P1 | Counter treats GS1 only when text starts `]d2` or `(01)` | A default-configured wedge scanner may be treated as text search | DEV-92 / DEV-575 |
| P1 | GS1 parser rejects scans whose last element's tail resembles an AI (e.g. 12-digit numeric serials) | Real packs may fail to scan at counter or goods-in | DEV-92 |
| P1 | Reprint flag comes from the client | Unmarked repeat copies possible | DEV-195 |
| P1 | Browser print cannot detect cancel or paper | No honest "printed" state | DEV-741 / DEV-742 |
| P1 | Real DVR stills unsupported | Transaction and cold-chain evidence cannot use real cameras | DEV-745 |
| P1 | Thermal printer model unknown (possibly Epson) and USB path unproven; USB is the owner's first priority | USB thermal cannot be planned or accepted without the exact model, driver and a dispatch path | Operator, DEV-741 |
| P2 | Saved paper format has no Pharmacy UI | Operators re-pick format every session | DEV-742 |
| P2 | Urdu thermal output depends on host fonts | Possible wrong glyphs on paper | DEV-742 / acceptance |
| P2 | DVR identified from a label photo only; firmware, protocols, codec and any connected camera models unknown | Cannot predict playback; DVR currently has no connected camera | Operator |
| P2 | Goods-in search only on Enter | Slower scanning workflow | DEV-734 |
| P3 | Network and Bluetooth thermal paths are preserved on paper only; no code target for Bluetooth | Other pharmacies may need them later | DEV-741 |
| P3 | Supported-browser policy for hardware features not documented | Support ambiguity | Product |
| P3 | Sensor ingest absent | Out of scope here | DEV-82 |

## 8. Safety rules and stop conditions

Stop and ask the owner before any of the following. Do not retry a refused action.

- Logging in to, configuring, rebooting or updating the DVR, a printer, a scanner or a terminal.
- Entering or reading any password, token, API key, RTSP URL with credentials or card data.
- Installing software, drivers, a print agent or a bridge on any machine.
- Changing firewalls, port forwarding, VLANs, DNS, TLS or any network/security setting.
  Never expose the DVR to the internet.
- Running a payment, refund or void on a live card or wallet.
- Pointing a test at production data or a real customer.
- Anything that sends output to a printer shared with live operations.

## 9. Evidence pack (required for any future PASS)

One folder per run, named `YYYY-MM-DD_<device>_<operator>`, containing:

1. Filled sections 4.1 to 4.5 for the device under test (no secrets).
2. Matrix row IDs attempted, with result, time, tester and app build SHA.
3. Photos of paper or screen captures. Redact patient names, card data, tokens, hostnames.
4. Raw scanner text captures (control characters shown as hex).
5. Audit-log excerpts for denied and allowed role tests.
6. A short list of deviations, retries and anything surprising.
7. A reviewer who did not run the test confirms the pack. Only then may a row move from
   `UNTESTED` to `PASS` or `FAIL`, in a follow-up change that cites the pack.

## 10. Untested compatibility register

Nothing is verified. Unknowns to resolve first: the DVR model/firmware/codec and whether it
offers a snapshot; every printer's code pages, cutter and real column width; every scanner's
mode, AIM and GS handling; whether any card terminal has a documented, certified
integration; whether browsers on the intended hosts can play the DVR's codec; Urdu font
availability on each print host.

## 11. How this document was verified

See the pull request for exact commands and results. These checks validate this document's
structure and the code facts it quotes. They do not validate any hardware.
