# UX-02 tickets: acceptance criteria

Status: proposed (WHA-1583) · Specs: `06-pharmacy-counter-flows-spec.md`,
`07-super-admin-console-ia.md`, `08-offline-state-language.md`

Three lanes, 27 tickets:

- **PHC-UX-1..6** (counter UI) plus **PHC-API-A..E** (counter server gaps)
- **SA-UX-1..11** (platform console UI). They pair with the SA-AUDIT-01 backlog SA-01..SA-12
  (WHA-1578), which remains the server-side and security source.
- **OFF-UX-1..4** (shared connection states) plus **OFF-API-1**

## Rules for every ticket

These are the same as `03-pos-ux-acceptance-criteria.md` "Rules for every ticket", with these
additions.

**Non-regression**

- No server contract changes unless the ticket is an API ticket or names a `[P-API-n]` item.
- These stay exactly as they are: idempotency keys, the tender unknown-outcome recovery
  (`tender-attempt-storage.ts`), non-bypassable safety blocks, the pharmacist `SIGN` gate, the
  platform command path (`executePlatformCommand` + one `PlatformAuditLog` row per attempt), and
  the connected-only rules in `08` §4.

**Verification to include in the PR comment (command + exit code + counts)**

- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` exits 0.
- `NODE_OPTIONS=--no-experimental-webstorage npx vitest run <touched dirs>` has no new failures
  against the 106-failure repo baseline. Give the counts.
- DB-touching tests run on a disposable PG lane (loopback 55600-55699; owner NOSUPERUSER
  NOBYPASSRLS CREATEROLE; runtime LOGIN NOSUPERUSER NOBYPASSRLS; prepare-extensions → migrate
  deploy → seed).
- Screenshots of every new state at 1024×768, 1366×768 and 768×1024 (terminals) or 1280×800 and
  1920×1080 (platform), light and dark, stored under the ticket's evidence path.

**Terminal tickets:** the `03` scroll check (no document scroll at the five viewports) applies to
`/pharmacy/counter` and `/kds` too.

**Copy:** no requirement codes in eyebrows (audit X-3), no raw enums (X-4), money through the
shared formatter (X-1), every destructive action through `ConfirmAction` (X-5).

---

## Lane 1: Pharmacy counter

### PHC-UX-1: Register menu + cash drawer sheet

**Scope.** `register-menu` on the counter's top bar (the same component as restaurant `02`
§3.2), a cash drawer sheet (open with float, paid in/out, movement log), and the two new keymap
actions. Spec `06` §1.1, §3.1.

1. The top bar has a `⋯` **Register menu** with the items and enablement in `06` §1.1, in that
   order. Offline, the money items are visible and disabled, each with the reason from `08` §4.
2. **Open drawer** takes an opening float from the note buttons (0 / 1,000 / 2,000 / 5,000) or a
   stepper. `openDrawer` receives that value; a unit test proves a non-zero float is sent. This
   fixes audit C-9. Today's page-level Open-drawer button is removed.
3. **Paid in / Paid out** call `drawerMovement` with a picked reason (`06` §3.1). Paid out above
   the D-P5 threshold requires a manager PIN on the inline keypad.
4. The movement log lists this session's movements with type in words and signed amounts. It
   shows **no** running expected balance while the drawer is open. A test asserts that no
   element contains the expected total.
5. `returnRefund` (`Shift+F9`) and `attachPrescription` (`Shift+F7`) exist in both keymap presets.
   `counter-keymap` conflict tests pass, and the `?` cheat sheet lists them.
6. The permanent keymap legend is gone from the page body (audit C-6); it's in the `?` sheet.

### PHC-UX-2: Close drawer sheet

**Scope.** `06` §3.2. Needs only `closeDrawer` (exists).

1. Step ① shows a PKR denomination grid (5,000 … 1) with steppers and typed fields, a pinned
   total, and an **Enter total only** toggle. The expected amount is not rendered anywhere in
   step ① or ②. A test proves this.
2. Step ② is a `ConfirmAction` review with the counted total in words and figures, and a
   destructive-toned **Close drawer** button.
3. Step ③ shows variance as `Balanced` (success), `Over Rs x` (warning) or `Short Rs x` (danger),
   always with the word, plus counted, expected, float, cash sales, cash refunds, paid in and paid
   out.
4. **Print close slip** prints denominations and all ③ figures. The last close result survives a
   sheet close and a page reload (device storage). **Reprint last close slip** appears in the
   drawer sheet until the next drawer opens.
5. `DRAWER_NOT_OPEN` and other close errors show the copy from `06` §3.3, never a raw 500 message.

### PHC-UX-3: Close day sheet

**Scope.** `06` §3.3. Needs only `dailyClose` (exists); the preview and breakdown wait for
PHC-API-B.

1. Step ① lists each check in `06` §3.3 with a status (`OK` / `Blocking` / `Warning` / `Not
checked`) and a fix action. Blocking checks disable **Next**. A check the client can't verify
   shows `Not checked` with the reason, never a green tick.
2. Without PHC-API-B, step ② is skipped and ④ reads _"Figures are calculated when you close"_.
   With it, ② shows gross, refunds, net, cash expected/counted/variance and the per-tender
   breakdown.
3. Step ③ (controlled count) appears only for pharmacist operators when controlled stock moved
   that day. It sends `controlledCountHook`. A non-zero difference needs a note.
4. Step ④ requires a manager PIN and names the date and branch in the confirm sentence.
5. A closed date opens on the summary with **Reopen and close again**, which requires a reason
   (≥10 chars) and a PIN, and sends `reopenReason`. `REOPEN_REASON_REQUIRED` can't be reached
   from the UI.
6. After a successful close the counter's business date moves to the next day, and the info
   banner `Day closed · new sales are dated {date}` shows for the session. A unit test proves the
   next `tender` call carries the new `businessDate`.
7. **Print Z summary** prints the result.

### PHC-UX-4: Return and refund sheet

**Scope.** `06` §2. Uses `returnLine` and `refundTender` (both exist); lookup and server
approval wait for PHC-API-A/B.

1. The sheet has four steps (Find sale → Items → Condition → Refund), each with Back that keeps
   input. The primary button names the amount (`Refund Rs 540`).
2. **Find sale** without PHC-API-B lists this session's completed sales; the receipt field is
   disabled with the hint text. With it, an exact receipt-number scan jumps to step ②.
3. **Items** show quantities in pack language (`2 strips (20 tablets)`), with steppers in the sale
   unit and a unit switch. The value sent as `canonicalUnits` is covered by a unit test for
   pack, strip and loose units.
4. Controlled lines are disabled for non-pharmacists with the `06` §2.4 copy. Fully returned and
   out-of-window lines are disabled with their reasons. Nothing is hidden.
5. **Condition** requires a reason and a pack condition per line, and shows the quarantine
   notice. It auto-selects the branch's only quarantine location, shows a picker when there are
   several, and blocks with a link when there are none.
6. **Refund** lists original tenders with refundable amounts. Card and Wallet are disabled with
   the `06` §2.2 copy. Cash without an open drawer offers **Open drawer** in place and returns to
   the step.
7. The client enforces the approval rules in `06` §2.6 with the inline PIN pad, and the code is
   commented as a stop-gap until PHC-API-A.
8. Calls run in the `06` §2.3 order with stable idempotency keys. The plan is persisted before
   the first call. Tests cover: (a) a retry after a network failure reuses both keys; (b) returns
   succeed and the refund fails → the warning panel, a `Refund not paid` row in Pending, and close
   day blocked; (c) a reload mid-plan resumes at the failed call.
9. Every server code in the `06` §2.3 table maps to its copy. No raw code appears in the DOM.
10. The done state prints a return note with the fields listed in `06` §2.2.

### PHC-UX-5: Prescription capture sheet

**Scope.** `06` §4.1–4.5. One sheet component, used by the counter and by
`/pharmacy/prescriptions`.

1. The counter opens the sheet from a `Prescription needed` block (**Attach prescription**), the
   patient card (**+ Prescription**) and `Shift+F7`. The back-office page uses the same component.
2. **Photo:** rear-camera capture on touch devices, file upload everywhere, up to 4 pages with
   rotate and retake, and images downscaled to ≤2000px before upload. Upload goes to
   `POST /api/upload`, and the returned `/api/files/...` path is sent as `sourceFileRef`. The
   `capture://` fake reference is deleted (`prescriptions-console.tsx:91`). A test asserts
   `sourceFileRef` starts with `/api/files/`.
3. Without PHC-API-E, several pages are combined into one PDF before upload.
4. The legibility checkbox is required to continue. **No photo — record details only** follows
   D-P9 and is never offered when any line is controlled.
5. **Patient & doctor** prefill from the counter, search with masked results, and create new
   records. An existing PMDC number matches instead of duplicating.
6. **Medicines** prefill from blocked bill lines. Authorised quantity uses pack language.
   Direction chips produce English and Urdu text.
7. After **Save prescription**, covered lines change from `Prescription needed` to `Prescription
attached · awaiting pharmacist` and the bill parks as `Awaiting pharmacist`. The sale still
   can't complete until the pharmacist signs (existing gate; a test proves it).
8. A bill quantity above the authorised quantity keeps the line blocked, with the **Set to {n}
   {unit}** action.
9. Prescription images load only through authenticated `/api/files/...` and are never written to
   device storage (a test on the storage adapter).

### PHC-UX-6: Controlled register prompt

**Scope.** `06` §4.6 ships-without-API default. PHC-API-E replaces it.

1. After a sale or return with a controlled line settles, the right zone shows the _register
   entry needed_ card with **Write entry now** and **Later**.
2. **Write entry now** (pharmacist only) opens a sheet prefilled from the sale. The serial and
   running balance are suggested from `pharmacySafety.controlledRegister`, and editing them
   requires a reason. It saves through `pharmacySafety.recordControlledEntry`.
3. **Later** adds the entry to the Register menu's _Controlled register (n)_ list, with a badge.
4. Close day step ① shows unwritten entries as Blocking when D-P7 says so.

### PHC-API-A..E: counter server gaps

Each is a separate server ticket, owned by the pharmacy engineering lane, with unit tests plus a
DB test on a disposable PG lane where it touches data.

| Ticket    | Items (from `06` §7)                | Exit                                                                                                                                                                                 |
| --------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PHC-API-A | P-API-2, P-API-6                    | `pharmacy:refund`, `pharmacy:drawer:close` and `pharmacy:day:close` are checked on the server (403, with the failure audited). Money errors return 4xx codes                         |
| PHC-API-B | P-API-3, P-API-4, P-API-9, P-API-12 | `findSale`, refundable amount, drawer movements + open drawers, and `dailyClose` preview + tender breakdown, each with tests                                                         |
| PHC-API-C | P-API-5, P-API-7, P-API-8           | Quarantine location validated; Rx return posts to the pharmacist queue; `allocationId` on `returnLine`                                                                               |
| PHC-API-D | P-API-10, P-API-11, P-API-13        | Denominations stored; close preview with the attempts logged; sales refused on a closed date                                                                                         |
| PHC-API-E | P-API-1, P-API-14, P-API-15         | Matched alias in search; several attachments per prescription; the controlled register is written in the sale/return transaction, with the serial and balance computed on the server |

---

## Lane 2: Super Admin console

Every SA-UX ticket follows `05` (friction levels, words not enums, 11px minimum, tables that
scroll inside their container) and `07`. Tests: page and `read-policy` tests per role for every
new or renamed route.

### SA-UX-1: Shell, navigation and global controls

1. The nav has the five groups and items in `07` §2.2, with no number prefixes and no
   "Runbook /" eyebrow. Labels are ≥11px. Existing routes keep their paths.
2. Items the operator can't read are hidden. `read-policy.test.ts` covers each role in the `07`
   §2.3 matrix once D-S1 is decided.
3. The environment label is always visible, with the tone per environment.
4. The vertical scope control writes `?vertical=` and persists in session storage. Every list
   page listed in `07` §2.1 honours it, and each has a test.
5. `⌘K` / `Ctrl+K` finds tenants by name, slug or short ID and pages by name. Action results open
   the review dialog and never execute directly (a test proves it). Email lookup arrives with
   SA-UX-5.

### SA-UX-2: Home

1. Vertical tiles show active, trial, grace and suspended counts, and each figure links to a
   filtered Tenants view.
2. **Needs attention** shows only rows with data behind them. Rows backed by an unbuilt source
   (e.g. health before SA-08) are omitted, not shown as zero.
3. Recent activity shows audit sentences in the `05` §6 format.
4. Roles without `crm:read` don't see pipeline figures.

### SA-UX-3: Tenants list (with SA-01)

1. Columns and filters are those in `07` §3.2. The vertical column and filter are backed by a
   page test for each vertical.
2. Filters apply on change, with no Apply button. Cursor pagination at 50 per page replaces
   `take 250`.
3. Saved views: the four defaults plus personal views per operator.
4. **+ New tenant** starts the `05` §5 stepper with vertical as step 1. The typed-password field
   is replaced by an admin invite.

### SA-UX-4: Tenant detail, tabs and entitlements

1. The identity bar is pinned on every tab (`05` §1). The seven tabs in `07` §3.3 each have their
   own URL. All 13 legacy anchors map to a tab; a test proves each legacy `#anchor` redirects
   to its tab.
2. **Modules & limits** shows the source column, grouping by core/vertical, the reset-to-plan
   action and usage bars (`07` §3.4). Turning a module off opens a review dialog with the
   consequence and a reason; the hard-coded reason at `organizations/[id]/page.tsx:782-809` is
   gone.
3. The Danger zone is at the bottom of Activity, with verb labels and the `05` §2 friction for
   each action. `window.confirm` is removed (`platform-command-form.tsx:515`).
4. Readiness panels show for all three verticals once SA-02 lands. Until then, pharmacy and
   agency tenants show _"Readiness checks for {vertical} are coming"_, not an empty panel.

### SA-UX-5: People (with SA-03, SA-05, SA-12)

1. Tenant → People shows the `07` §3.5 columns. Departments come from the tenant's vertical
   (SA-03).
2. **Send password reset link** replaces setting a password. The typed-password control is
   removed. It needs `organizations:security:write` and a reason (SA-05).
3. The People directory does an exact-email lookup only. Each lookup writes an audit row. The
   projection has no password or 2FA fields (a test).

### SA-UX-6: Billing (with SA-11)

1. The tabs and dunning column are those in `07` §3.8. Before SA-11, the dunning column reads
   `Manual`, and the next step is a disruptive action with review and reason.
2. Suspending for non-payment names the consequence and, when D-S4 allows it, schedules the
   tenant announcement.

### SA-UX-7: Audit log (with SA-04)

1. Rows are sentences with names. IDs sit behind copy buttons. Raw codes show only in the detail
   drawer.
2. Filters: tenant, vertical, actor, action group, outcome, date. Cursor pagination replaces the
   500-row cap. **Export CSV** exports the current filter and is itself audited.
3. Denied and failed attempts are listed with the outcome filter.
4. The word "immutable" appears nowhere in the console until SA-04's DB test (UPDATE/DELETE
   refused under platform context) passes. A grep in the PR shows 0 hits before that.

### SA-UX-8: Health (with SA-08)

1. The three sections in `07` §3.9. The worker heartbeat turns danger at >10 min without a run.
2. The Terminals section uses the `08` connection words. Counts link to tenants.
3. Roles: SUPPORT and AUDITOR can read, SALES is denied (page test).

### SA-UX-9: Support sessions (with SA-07)

1. The start flow has the five steps in `07` §3.11. Read-only is the default once SA-07 adds the
   mode. Non-admin targets require Super admin.
2. The top bar shows the active session count. The Support sessions page lists active and past
   sessions with **End session** (force-end, audited). A test proves the tenant cookie is
   invalid on the next request.
3. The tenant banner shows a live countdown, the operator's name, the mode and **End now**.
   Tenant admins get the in-app notice.

### SA-UX-10: Feature flags (with SA-09)

1. The list and detail are those in `07` §3.12. Targeting order is shown explicitly, and the
   evaluation preview names the deciding rule.
2. Changes that affect >1 tenant show the tenant count and need a reason. The kill switch is a
   disruptive action. Every change is audited.
3. Tenant → Deployment lists effective flags read-only.
4. The page description states that flags aren't entitlements.

### SA-UX-11: Announcements (with SA-10)

1. The composer has the fields and the live preview (back office + terminal, light + dark) from
   `07` §3.13. Review shows the audience count.
2. The tenant app shell shows the banner by severity tone. Info is dismissible per user;
   Maintenance and Incident aren't while active.
3. Terminals show only Maintenance and Incident, in the `08` banner row, **below** any connection
   banner (a component test with both present).
4. Ending an announcement early is audited.

---

## Lane 3: Offline-state language

### OFF-UX-1: Shared connection model and components

**Scope.** `08` §1–§3, §5, §6: `connection-state.ts`, `use-terminal-connection.ts`,
`connection-badge.tsx`, `connection-banner.tsx`, `connection-sheet.tsx` and `pending-row.tsx` in
`src/components/terminal/`.

1. The state type, precedence function and label map match `08` §1 and §3 exactly. A unit test
   covers every pair of simultaneous states for precedence.
2. Detection and hysteresis match `08` §1.2 and are tested with fake timers. `navigator.onLine`
   alone never yields Online.
3. The badge always renders, including Online. Its accessible name is the full sentence.
4. The banner reserves its row. A test asserts that the frame's body row has the same `top` with
   and without the banner.
5. `pending-row` renders exactly the statuses in `08` §5, with those tones and actions. Any other
   status is a type error.
6. The Urdu labels are behind the terminal language setting and flagged `needsReview` in the
   label map until a native speaker signs them off.
7. `offline-queue-status.tsx` is replaced. Its test moves or is deleted, and nothing imports it.

### OFF-UX-2: POS adoption

**Scope.** Wire the POS to OFF-UX-1. This lands with or after POS-UX-5 (`03`) and supersedes its
banner copy.

1. The POS header pill and the "Offline queue" card are removed. The badge and banner replace
   them.
2. Banner copy is the POS column of `08` §3.1. `Queued {n}` becomes `Saved {n}`; the e2e
   assertion and `order-pad.test.tsx` are updated in the same PR.
3. The Pending sheet uses `pending-row` statuses. `Needs review` rows keep **Send anyway** /
   **Discard** (confirm).
4. The `08` §4 POS column is enforced: every ✕ control is disabled with its reason, and a test
   iterates the matrix.
5. The degraded state triggers for a failing print bridge (dependency) with the printer copy.

### OFF-UX-3: KDS adoption

1. The KDS pill `disconnected / loading / error / active` and the "Last synced" strip are
   replaced by the badge and banner. **Last synced** time moves into the banner and the
   Connection sheet.
2. Degraded when polling has backed off to ≥20 s; Offline on `offline` or 2 failed polls. The
   board dims to 70% while Offline.
3. Bump and recall are disabled offline, with the `08` §4 reason.
4. The banner text is 18px on KDS.

### OFF-UX-4: Pharmacy counter adoption

Split in two so the counter gets a visible state before offline selling is wired.

**OFF-UX-4a: indicator only (no server dependency)**

1. The counter shows the badge and banner, driven by request health and `navigator.onLine`. This
   fixes audit C-1.
2. While Offline, every action is disabled with the reason _"The counter needs a connection
   today. Offline sales are coming."_ Bills in progress stay on screen, and nothing is lost on
   reconnect (tested).
3. The Card/Wallet degraded state shows when no certified adapter is configured (audit C-8).

**OFF-UX-4b: offline selling (depends on OFF-API-1)**

1. The counter uses `PharmacyCounterRuntime`. The `08` §4 counter column is enforced from
   `offline-action-matrix.ts`, and a test iterates the matrix against the UI.
2. The safety-data line and the expiry and recall behaviours in `08` §4.1 are implemented and
   tested with fake timers.
3. Offline receipts print `Issued offline · {hh:mm}` with the reserved receipt number.
4. Quarantined sales appear as `Sale not recorded` with no Discard, and block close day.

### OFF-API-1: Counter offline endpoints

1. `/api/pharmacy/offline/commands` exists (today it's only a string at
   `counter-command-queue.ts:375`). It uses `offline-command-log.ts`, `offline-quotas.ts` and
   `offline-receipt-leases.ts`, and it honours `Idempotency-Key`.
2. Snapshot and safety-lease issuance endpoints exist, and snapshots are Ed25519-signed.
3. DB tests on a disposable PG lane cover idempotent replay, quota exhaustion and a
   recall-before-sale.
