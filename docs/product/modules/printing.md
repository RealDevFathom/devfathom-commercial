# Restaurant printing

DevFathom queues ESC/POS kitchen order tickets (KOTs) when an order or course is sent. A kitchen
display (KDS) is optional: a station can use a printer route, a KDS screen, both, or neither.

## Transport configuration (Windows, macOS and existing POSIX devices)

The bridge consumes the existing branch-scoped ESC/POS job contract for KOTs and receipts. It
does not render a new receipt format. USB, Bluetooth, Wi-Fi and Ethernet describe connections;
the printer must also understand the emitted ESC/POS language. A generic PDF, raster-only,
AirPrint-only or vendor-specific printer is not automatically compatible.

### Supported host and prerequisites

- Run the repository's `restaurant:print-bridge` script with Node.js 22 and its installed `tsx`
  dependency. The repository's builder uses Node 22; `package.json` does not pin a Node engine.
  Developer evidence for this change: Node **22.23.1**, `tsx` **4.23.1**, macOS **27.0**, ARM64.
  Tests use fake TCP and mocked native commands; no Windows execution or physical queue tested.
- Node 22's platform floors include Windows 10 and macOS 11. Node 24's official floors are
  Windows 10 x64/ARM64 and macOS 13.5 x64/ARM64. These floors do not override vendor end-of-life
  rules or certify this bridge on every listed OS; use a vendor-supported host release.
  See [Node 22 platforms](https://github.com/nodejs/node/blob/v22.x/BUILDING.md#platform-list)
  and [Node 24 platforms](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list).
- Windows queue transport requires an already installed local printer queue supporting RAW
  ESC/POS, Windows PowerShell 5.1, and permission to run the checked-in helper and `Add-Type`.
  The helper uses [Winspool RAW submission](https://learn.microsoft.com/en-us/windows/win32/printdocs/sending-data-directly-to-a-printer).
  It does not install a driver, bypass execution policy, elevate, or change machine settings.
- macOS queue transport requires an already installed local CUPS destination that accepts raw
  ESC/POS and `/usr/bin/lp`. The bridge explicitly selects the local scheduler and destination
  using [`lp` argument options](https://www.cups.org/doc/man-lp.html), with `-o raw`.
  RAW support depends on the installed queue/backend and must be checked on the target host.
- Windows 98, Vista and 7 cannot run the supported modern Node/browser path. Connect the printer
  directly to a separate supported bridge host, or use its explicitly configured TCP endpoint
  if the model supports it. A USB-only printer needs a supported-host driver/queue or compatible
  device node. No insecure legacy build, legacy SMB dependency, or universal adapter is provided.

### Device UI / operator contract

Keep the existing `printerId` field (maximum 128 characters). The transport-address field keeps its existing meaning; bridge enrollment uses separate device/code records:

| Transport               | Example printer ID                                                 | Requirements                                                                                        |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Raw TCP                 | `tcp://192.168.1.50:9100`                                          | Explicit reachable host; omitted port defaults to 9100                                              |
| Windows installed queue | `queue:///Receipt%20Printer`                                       | Local installed queue name, URL-encoded; no UNC paths                                               |
| macOS installed queue   | `queue:///Receipt_Printer`                                         | CUPS destination name; letters/numbers/underscore first, then letters/numbers/underscore/dot/hyphen |
| Existing POSIX device   | `/dev/usb/lp0`, `usb:///dev/usb/lp0`, `serial:///dev/cu.usbserial` | Writable character device, already configured by operator/vendor                                    |

Queue names are explicit; the bridge never discovers devices or uses the OS default printer.
USB/Bluetooth printers can use an installed queue if that queue passes RAW ESC/POS. Wi-Fi/Ethernet
can use either raw TCP or an installed queue. Direct USB enumeration, Bluetooth pairing/GATT,
Windows COM configuration, and serial baud/parity/flow-control setup are not implemented.
POSIX device writes do not create/truncate ordinary files or follow a final device symlink.

Host configuration:

| Variable                   | Meaning                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `PRINT_BRIDGE_BASE_URL`    | HTTPS application URL without embedded credentials, query or fragment; redirects rejected                            |
| `PRINT_BRIDGE_TOKEN`       | Dedicated registered-device secret for the intended branch; inject through trusted local secret handling             |
| `PRINT_BRIDGE_PRINTER_IDS` | Required JSON array of 1–100 exact allowed printer IDs, covering the branch's routed printers                        |
| `PRINT_BRIDGE_STATE_DIR`   | Required persistent absolute local directory; keep it private to the bridge operator and preserve it across restarts |
| `PRINT_BRIDGE_PRINTER_ID`  | One allowlisted ID for `--dry-run` only                                                                              |

Integration prerequisite: compose with **WHA-1360** queue-security API/service private commit
`bc0693705163c618c3445ffcc7c8b89f13ac8024` and the **WHA-1354** shared `ClaimedPrintJob.claimToken`
field. GET job must include `claimToken` (64 lowercase hex characters). This bridge validates its
shape and echoes the opaque value in POST `{ jobId, claimToken, status: 'PRINTED' }` using the same
device Bearer. Token verification/30-second lease enforcement belong to the server; the token is
never logged or persisted locally. The base `fe1e3e3` API has no claim token and is intentionally
rejected before dispatch. Do not run this bridge against that older API. Chief of Staff owns
combined integration/review; these shared files are outside this transport change.

The allowlist is an additional local boundary; it does not replace tenant/branch/device authorization.
Use one bridge host per branch. Multiple hosts with separate state directories cannot coordinate
duplicate prevention under the existing server lease contract. Do not change token/branch/host or
discard state while jobs remain unresolved. Back up and transfer state during a planned host move.

### Installer-free operator commands

Run from a prepared checkout with its existing dependencies. These foreground commands do not
install a driver or background service. First validate a synthetic receipt with **no network,
queue, device, state-file or application access**:

macOS / POSIX shell:

```sh
export PRINT_BRIDGE_PRINTER_IDS='["queue:///Receipt_Printer"]'
export PRINT_BRIDGE_PRINTER_ID='queue:///Receipt_Printer'
npm run restaurant:print-bridge -- --dry-run
```

Windows PowerShell:

```powershell
$env:PRINT_BRIDGE_PRINTER_IDS = '["queue:///Receipt%20Printer"]'
$env:PRINT_BRIDGE_PRINTER_ID = 'queue:///Receipt%20Printer'
npm run restaurant:print-bridge -- --dry-run
```

Dry-run reports the resolved transport, byte count/hash of a fixed synthetic receipt, native
executable where relevant, and `physicalOutputVerified: false`. It does not establish that the
queue exists or that paper will print. Unknown arguments and invalid/unapproved IDs fail closed.

Only after the owner approves the configured staging revision and physical target, start real
branch polling. Inject `PRINT_BRIDGE_TOKEN` securely first; do not paste real secrets into command
history, repository files or logs.

```sh
export PRINT_BRIDGE_BASE_URL='https://your-devfathom-host.example'
export PRINT_BRIDGE_STATE_DIR="$HOME/Library/Application Support/DevFathom/print-bridge"
npm run restaurant:print-bridge
```

```powershell
$env:PRINT_BRIDGE_BASE_URL = 'https://your-devfathom-host.example'
$env:PRINT_BRIDGE_STATE_DIR = Join-Path $env:LOCALAPPDATA 'DevFathom\print-bridge'
npm run restaurant:print-bridge
```

Stop with Ctrl+C. No device credentials are guessed; the bridge does not install or repair OS
queues. Native subprocesses receive fixed argument arrays and a restricted environment without
the device secret. Receipt bytes go through stdin, not command arguments or temporary receipts.

### Set up a TCP kitchen printer

1. Give the printer a stable address on the restaurant network and enable raw TCP printing on port
   `9100`.
2. In **Settings → Printing**, select the branch and add an enabled **Kitchen printer (KOT)** route
   for the station. Use a printer ID such as `tcp://192.168.1.50:9100`.
3. Issue a dedicated registered-device secret for the same branch through restaurant device
   management. Device secrets are shown once; do not place the secret in source control or logs.
4. On the supported bridge host, use the same ID in the host allowlist, inject the device secret,
   and set a persistent state directory as above. Validate before starting polling:

   ```sh
   export PRINT_BRIDGE_PRINTER_IDS='["tcp://192.168.1.50:9100"]'
   export PRINT_BRIDGE_PRINTER_ID='tcp://192.168.1.50:9100'
   npm run restaurant:print-bridge -- --dry-run
   ```

### Acceptance, failure and duplicate prevention

The bridge long-polls branch-scoped jobs, persists an exclusive attempt marker **before** writing,
and acknowledges the existing `PRINTED` status only after transport acceptance. Socket flush,
device write and OS spool acceptance do **not** prove paper output, cutter behavior or legibility.
The OS spooler may itself retain/retry an accepted job while the printer is offline.

Any polling, transport or acknowledgement failure stops this process. TCP/device operations are
bounded to five seconds where the underlying nonblocking device permits; native queue submission
is bounded to fifteen seconds. Claims and acknowledgements have 25/5-second deadlines. Receipts
are limited to 1 MiB. Native stderr and receipt contents are never logged.

The WHA-1360 server holds attempted jobs instead of automatically reoffering them. The local marker
also blocks repeat dispatch on the same persistent host if a job is offered again, including after
restart or partial delivery. The bridge deliberately
does not report `OFFLINE` and automatically resend a potentially delivered job. Markers contain
only `attempted` and use SHA-256 filenames derived from application origin/job ID; they contain
no receipt or token. A crash between marker creation and dispatch can leave an **unprinted** job
blocked: this favors avoiding duplicates over unattended recovery. Disk-full/permission errors
also stop before dispatch. Windows sudden-power-loss durability still needs target-host validation.

On failure, stop any other branch bridge, inspect the configured OS queue and physical printer,
and reconcile the job in DevFathom before restarting. Never delete an attempt marker simply to
force a retry. **Reprint KOT** intentionally creates another job/copy and requires operator judgment
after checking for pending spool output. Keep markers until an authorized reconciliation confirms
the server cannot redeliver those jobs; automatic pruning is intentionally absent. Rollback means
stopping this bridge and preserving its state, not restarting the older auto-retrying runtime.

### Remaining physical acceptance gate

Owner **Saad**, with the staging/release owner, must name the staging revision, branch/device,
printer model/firmware, actual installed queue/device or TCP endpoint, OS/runtime/architecture,
driver and connection type before hardware access. Then verify separately on Windows and macOS:
one receipt/KOT, readable layout/code page, cut/feed, disconnect/offline/permission behavior,
pending OS spool behavior, lost acknowledgement/restart without duplicate output, and recovery.
No physical printer, native Windows spooler, macOS queue, or browser acceptance is claimed here.
Receipt designer/UI, shared rendering and other verticals remain their owners' separate lanes.


## One-use bridge enrollment

In **Restaurant → Devices**, choose **Enroll print bridge**, name the host, and explicitly select
its branch. Device-management permission, current branch authorization, and the active registered-device
limit are checked on the server. The action creates a new PRINT_BRIDGE device and a ten-minute,
one-use enrollment code. It cannot reissue a code for an existing device or replace manager
co-authorization for rotation/revocation. Copy the displayed code securely before closing the dialog. A user or organization change clears
its ownership; results from the prior identity are discarded. If creation is uncertain, closing and
reopening retains the reconciliation warning. Confirm reconciliation explicitly before creating another device.

On a supported POSIX host, provide `PRINT_BRIDGE_ENROLLMENT_CODE` through trusted local secret
handling, `PRINT_BRIDGE_BASE_URL`, and a new absolute `PRINT_BRIDGE_TOKEN_FILE` in a private,
existing directory. Configure the same printer allowlist and persistent attempt-state directory
as above. Do not paste a real enrollment code or device token into shell history.

Credential precedence is injected `PRINT_BRIDGE_TOKEN`, then an existing valid owner-only token
file, then enrollment when the selected file is absent. Invalid, unreadable, empty, or symlinked
files stop before exchange. Enrollment reserves a new mode-0600 file exclusively before its one-use
HTTPS exchange, rejects redirects, and persists the returned token through the reserved descriptor.
Later starts reuse that file; remove the enrollment-code environment setting after confirmed setup.
Windows keeps the injected-token path; this owner-only file enrollment path requires POSIX support.
`--dry-run` does not read credentials, enroll, or create a token file.

An uncertain exchange is never retried automatically. The reserved file remains, even if empty.
Keep it, stop the host, and have the administrator reconcile the new device and any outstanding
print jobs. A response may have been lost after the code was consumed. Use the existing authorized
rotation/revocation workflow for recovery; do not delete files or retry codes blindly. A complete
valid token file may be reused after the operator verifies the outcome. Codes, tokens, and hashes
are excluded from device lists, audit details, and bridge error output.

PRINT_BRIDGE credentials can claim and acknowledge print jobs but cannot create or use terminal
sessions. Existing POS/KDS printing remains supported. Printer inventory, ownership records and
printer-ID foreign keys are not part of this source integration: route IDs remain explicit transport
addresses. Application schema now records this separately from the fixed initializer profile.

Source checks use mocked exchanges and synthetic files. Enrollment migrations, database locking/RLS,
authenticated browser behavior, native spoolers and physical output still require separately authorized
runtime acceptance. This source integration does not authorize startup or deployment.


## Printer inventory source foundation

Device-management APIs now support optional 1–20 printer entries while creating a new bridge,
plus explicit registration on an existing active bridge and a management-only branch inventory
query. Omission preserves enrollment without printers. Device, inventory and enrollment-code
writes share one transaction; registration on an existing bridge never issues a code or rotates
its token. Inventory stores branch/bridge ownership, name, explicit target, 58/80 mm width and
passive status/telemetry fields. New records default to OFFLINE; registration proves no connectivity.

Inventory targets use the same parser as the accepted bridge: explicit TCP, installed local
queues or supported POSIX /dev/ paths, limited to 128 characters. The captured donor's 500-character
and arbitrary absolute-path acceptance is preserved as source evidence but is not accepted as
safe transport behavior. No address-valued job or route ID is converted into a database ID.
Inventory routing selection, status reporting, update/retirement and UI wiring remain follow-on
work. Existing device/demo lists and rotation/revocation authorization remain unchanged.
