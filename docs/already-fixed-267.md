# GitHub issue #267: already fixed

Issue #267 reported that campaign reach was always returned as `0` and that the audience copy
described consent as customers who said “haan”. The current implementation no longer contains
either behavior, so no production code or migration is required.

Verification was performed against the current branch rather than inferred from the issue's
`aba82bfd` found-at revision. The referenced `growth.ts` is no longer present: the live pharmacy
campaign path is the scoped marketing service and its review page described below.

## Current-code evidence

- `src/lib/pharmacy/marketing-service.ts:255-268` builds the candidate audience from distinct
  customer IDs with completed, non-returned receipts, scoped by both organization and branch.
- `src/lib/pharmacy/marketing-service.ts:273-336` evaluates every candidate against the campaign
  rules, current consent, and frequency cap, increments `prepared` for every eligible customer,
  and returns that computed value. `src/lib/pharmacy/marketing-service.ts:339-344` exposes the same
  evaluation as the read-only campaign preview. Reach is therefore derived from the eligible
  audience rather than hardcoded to zero.
- `src/lib/pharmacy/marketing-service.ts:203-227` requires an active customer whose
  `whatsappOptIn` is explicitly `true` and whose latest `MARKETING` / `WHATSAPP` consent is granted,
  effective, and not revoked. Both customer and consent reads include the organization ID.
- `src/lib/pharmacy/whatsapp/messages.ts:64-78` recognizes `START` and `شروع` (including the
  supported Urdu phrase `شروع کریں`) as opt-in keywords; “haan” is not an opt-in keyword.
- `src/lib/pharmacy/whatsapp/inbound.ts:151-186` maps only a recognized `START` keyword to
  `OPT_IN` and persists the opt-in under the supplied organization scope. Lines 182-186 make STOP
  win an equal-timestamp race, preserving the deny-over-allow rule.
- `src/server/routers/pharmacy-marketing.ts:50-87` requires an administrator with Pharmacy CRM,
  derives the organization from entitlements, and verifies that the requested active branch
  belongs to that organization before creating the marketing scope. The preview endpoint uses
  that scope at `src/server/routers/pharmacy-marketing.ts:241-246`.
- User-facing campaign review copy now says “Preview audience” and explicitly says consent and
  caps are checked again at capture (`src/app/(app)/pharmacy/marketing/page.tsx:176-207`); it does
  not describe “haan” as consent.

## Existing focused coverage

- `src/lib/pharmacy/marketing-service.test.ts:171-191` asserts that preview returns a computed
  nonzero `prepared` count without writes and that capture/replay retains the count.
- `src/lib/pharmacy/marketing-service.test.ts:193-217` asserts tenant-and-branch-scoped receipt
  selection and exclusion when the explicit WhatsApp opt-in is false or absent.
- `src/lib/pharmacy/marketing-service.test.ts:219-230` asserts selection of the latest scoped
  `MARKETING` / `WHATSAPP` consent and honors revocation.
- `src/lib/pharmacy/whatsapp/inbound.test.ts:239-245` covers opt-out followed by START opt-in, while
  `src/lib/pharmacy/whatsapp/inbound.test.ts:286-309` covers stale and equal-time races, including
  STOP winning over START.

Per the issue instruction for an already-fixed finding, this evidence note is the only change.
