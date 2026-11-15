# Pharmacy receipt designer with protected fiscal fields — plan (DEV-750)

> **PLANNING ONLY — NOT AN IMPLEMENTATION AUTHORIZATION.**
> This document proposes a design. It does not authorize code, a deployment, a live fiscal
> submission, or any printer or network access. Nothing here is a compliance claim.
>
> **OWNER/LEGAL SIGN-OFF REQUIRED.** Every fiscal field, every FBR QR/barcode rule and every
> jurisdiction rule below is marked `SIGN-OFF REQUIRED`. None of them may be locked into the
> schema, the renderer or the UI until the owner and a qualified tax/legal adviser have checked
> them against the current official FBR/PRAL and provincial sources and recorded that sign-off in
> section 9.

Tracking: DEV-750 (GitHub #1414).

## 1. Reading this document

- **FACT (code)** — verified by reading this repository on `develop`; file paths are given.
- **SIGN-OFF REQUIRED** — a legal, fiscal or jurisdiction rule that has not been verified against a
  current official source. It is a question for the owner and adviser, not a decision.
- **PROPOSED** — a design proposal for review. Not built.

No preview, screenshot or automated test can prove that a physical printer output is correct or
that a receipt meets FBR requirements. Those claims need the physical evidence pack in
`docs/pharmacy/hardware-acceptance-matrix.md` and an accepted, authorized integration response.

## 2. What exists today (FACT, code)

| Area | Where | What it does today |
| --- | --- | --- |
| Shared layout schema | `src/lib/receipts/configuration.ts` | `ReceiptLayoutSchema` v1: `paperWidth` 58/80, `businessText`, `headerText`, `footerText`, `showOrderNumber`, `showChannel`, optional `browserPaper` THERMAL/A4. Plain text only: control characters, bidi overrides and `<`/`>` are rejected. Corrupt stored values fail closed. |
| Shared preview | `src/lib/receipts/preview.ts` | `buildReceiptPreview(layout, facts)` — facts come from a settled snapshot and are never calculated in the preview. 32/48 column wrapping for ASCII; Unicode lines kept whole for browser `pre-wrap`. |
| Restaurant designer | `src/components/receipts/receipt-designer.tsx`, `/settings/receipts`, `src/app/api/restaurant/receipt-layout/route.ts` | Restaurant-only. DEV-354 removed it from pharmacy; it must not be re-exposed to pharmacy. |
| Pharmacy persistence | `PharmacyBranch.receiptLayout` / `receiptLayoutRevision` (`prisma/schema.prisma`); `readPharmacyReceiptFormat` / `savePharmacyReceiptFormat` in `src/lib/pharmacy/receipt-print.ts` | Branch-scoped, optimistic revision. Router: `counterReceiptFormat` (read) and `counterSaveReceiptFormat` (admin save) in `src/server/routers/pharmacy-sales.ts`. |
| Printer settings / test print | `src/components/pharmacy/printer-settings.tsx`, `/pharmacy/settings/printers` (DEV-742) | Paper width, thermal/A4 default, test print. Keeps header/footer text but offers no content or layout design. |
| Thermal (ESC/POS) receipt | `src/lib/pharmacy/receipt-print.ts` | Printable ASCII only; non-ASCII (Urdu) refused with the `BROWSER_OS` fallback. Reprint is a read and only marks the paper. |
| Browser receipt | `src/lib/pharmacy/counter-browser-print.ts`, `src/lib/pharmacy/counter-receipt-presentation.ts` | Unicode/Urdu path. Uses `DEFAULT_RECEIPT_LAYOUT` with the saved paper width only; **the saved header/footer/business text is not applied** (gap). |
| Receipt strings / identity | `src/lib/pharmacy/counter-receipt.ts` | English/Urdu strings, `PharmacyReceiptTaxIdentity` (address, phone, licence number, NTN, STRN — null fields omitted, never invented), reprint marking "Reprint — not a new sale". |
| Regulatory identity source | `BranchRegulatoryProfile` (versioned, effective-dated: licence, NTN, STRN, province) | The only source for printed legal identity. |
| Fiscal boundary | `src/lib/pharmacy/fiscal.ts`, `PharmacyFiscalConfiguration`, `PharmacyFiscalDocument` | Modes are `OFF` and `SANDBOX` only. No licensed integrator is selected. `receiptFiscalFields()` returns `undefined` for every current mode, so no fiscal field reaches a receipt. Sandbox references are prefixed `SANDBOX-`. |
| Tier-1 self-check | `src/lib/pharmacy/fbr-tier1.ts` | Guidance only, cites the FBR POS booklet (2025-05-16). Not a receipt rule. |

## 3. Proposed design (PROPOSED)

### 3.1 Route, permissions and isolation

- New pharmacy page under `/pharmacy/settings/receipts`, beside printers, built from the Studio
  shell and components in `docs/design-system/DEVFATHOM-STUDIO.md`. No restaurant route, router or
  component is linked from pharmacy.
- Read reuses `counterReceiptFormat` access; save reuses `counterSaveReceiptFormat` (admin) and its
  branch scope check. No new ABAC action unless review asks for a narrower "configure receipts"
  capability.
- Tenant isolation stays on `organizationId` under row-level security; branch id is taken only
  from the authorized branch scope. Every save writes an audit record with old and new revision.

### 3.2 Schema extension (`ReceiptLayout` v2)

Keep v1 readable; add a strict v2 with a migration-free upgrade (JSON column already exists):

| Field | Purpose | Notes |
| --- | --- | --- |
| `paperWidth` 58/80, `browserPaper` THERMAL/A4 | Unchanged | — |
| `businessText`, `headerText`, `footerText` | Unchanged validation | Plain text, same limits. |
| `alignment` per block: `start`/`center`/`end` | Layout | Logical (RTL-aware) values, never left/right. |
| `emphasis` per block: `normal`/`bold`/`large` | Typography | Maps to a fixed ESC/POS subset and fixed CSS classes. No fonts, sizes or raw commands. |
| `sections` ordered list of optional section ids | Arrangement | Only optional sections (header text, footer text, branding QR, customer note, loyalty). Protected sections are not in this list and cannot be reordered out. |
| `logo` `{ assetId, maxWidthMm }` | Branding | Upload through the existing file pipeline; raster only, size-capped, re-encoded server-side; never SVG/HTML. Thermal prints a pre-dithered bitmap or falls back to text. |
| `brandingQr` `{ url }` | Optional branding QR | HTTPS URL only, printed with the caption "Scan for our website — not a tax invoice". Must never sit in the fiscal block or look like it. |
| `locale` `en`/`ur`/`both` | Language | Urdu goes through the browser path only. |

Not allowed in any version: arbitrary HTML, CSS, markup, printer command bytes, free-form templates,
or any field that writes to a protected block.

### 3.3 Protected blocks (rendered from facts, never from layout)

The renderer composes `layout` (editable) around a fixed `protected` sequence built only from the
settled sale snapshot, the effective `BranchRegulatoryProfile`, and an accepted fiscal document:

1. Legal identity — registered name, address, licence number, NTN, STRN.
2. Invoice identity — receipt number, issue date/time, branch, counter.
3. Lines, recorded amounts, discounts, tax lines, totals, payments, change.
4. Original / reprint / duplicate marking.
5. Fiscal block — integrator invoice number and FBR QR/barcode, **only** when section 3.4 allows.

The layout can change position of optional sections and styling around these blocks. It cannot
hide, reorder away, restyle to unreadable, truncate or edit them. The server re-validates every
render request; the UI is not the enforcement point.

### 3.4 Fiscal data rule (SIGN-OFF REQUIRED)

- Fiscal invoice number and FBR QR come only from a `PharmacyFiscalDocument` with status
  `ACCEPTED`, from a production integrator mode that does not exist yet (only `OFF`/`SANDBOX`).
- `SANDBOX` output, local mock values, user input and layout fields can never populate the fiscal
  block. `receiptFiscalFields()` stays the single gate and stays `undefined` until a licensed
  integrator is selected and signed off (DEV-680).
- No receipt may print an FBR logo, "FBR verified" wording or an FBR-style QR unless the fiscal
  block is populated by that gate.

### 3.5 Rendering consistency

- One render model (`protected` + `layout` → ordered blocks) feeds both the browser renderer and
  the ESC/POS renderer, so preview, browser print and thermal print come from the same data.
- Thermal stays printable-ASCII; any Urdu/non-ASCII content, logo the printer cannot raster, or QR
  that cannot meet the signed-off size routes to the browser/OS fallback instead of degrading.
- A4 uses paginated CSS with a repeated header and "Page n of m"; protected totals are never split
  from their label.

### 3.6 Editor UX

- Branch selector, live preview at 58 mm, 80 mm and A4, English/Urdu toggle, sample facts clearly
  labelled "Sample — not a real sale".
- Draft vs saved state shown; Discard and Reset to default; save uses the existing revision and
  shows a conflict message that reloads the saved version without losing the draft.
- Protected blocks shown locked with an explanation; keyboard and screen-reader accessible; Studio
  tokens only.

## 4. Dependency map

| Dependency | Status | Blocks |
| --- | --- | --- |
| DEV-742 printer settings and test print (#1409, merged as `e37ea94`) | Done | Paper width/A4 source; designer reuses it, no duplicate settings. |
| DEV-636 receipt content and pharmacy identity (#1378) | Not on develop | Wording and identity block content; designer must not fork it. |
| DEV-637 branch-wide receipt numbering (`9a2dbfd`) | Done | Invoice identity block. |
| DEV-100 Sindh cash-memo mode | Not on develop | Cash-memo field set per province (section 5.2). |
| DEV-680 FBR POS real-time reporting / licensed integrator | Not on develop; no integrator selected (`fiscal.ts`) | Any fiscal block content; FBR QR rules. |
| DEV-744 hardware acceptance matrix (`docs/pharmacy/hardware-acceptance-matrix.md`) | Document on develop | Physical scannability and print evidence. |
| DEV-354 restaurant designer removed from pharmacy | Done (Linear) | Must stay removed. |
| Owner/legal sign-off (section 9) | **Not given** | Locking any field in sections 3.3–3.4 and 5. |

## 5. Official-source field checklist (SIGN-OFF REQUIRED)

Every row is unverified until an adviser fills the source, version date and applicability columns
from a current official document. Do not lock a field with an empty source.

### 5.1 FBR-integrated invoice (Tier-1 retailer, if applicable)

| Field | Proposed source in DevFathom | Official source / version / applicability | Status |
| --- | --- | --- | --- |
| Seller name and address | `BranchRegulatoryProfile` | — | SIGN-OFF REQUIRED |
| Seller NTN | `BranchRegulatoryProfile.ntn` | — | SIGN-OFF REQUIRED |
| Seller STRN | `BranchRegulatoryProfile.strn` | — | SIGN-OFF REQUIRED |
| POS ID | Integrator registration | — | SIGN-OFF REQUIRED |
| FBR invoice number | Accepted `PharmacyFiscalDocument.externalReference` | — | SIGN-OFF REQUIRED |
| Local invoice number, date and time | Settled sale | — | SIGN-OFF REQUIRED |
| Item description, quantity, price, value | Settled sale lines | — | SIGN-OFF REQUIRED |
| Sales tax rate and amount per line / total | Settled tax facts (none for pharmacy today) | — | SIGN-OFF REQUIRED |
| Total incl. tax, discount, payment mode | Settled sale | — | SIGN-OFF REQUIRED |
| Buyer NTN/CNIC (if required above a threshold) | Not captured today | — | SIGN-OFF REQUIRED |
| FBR QR code / barcode content | Accepted `PharmacyFiscalDocument.externalQr` only | — | SIGN-OFF REQUIRED |
| FBR logo / verification wording | Only with accepted fiscal data | — | SIGN-OFF REQUIRED |
| Credit/debit note linkage | `assertFiscalLinkage` | — | SIGN-OFF REQUIRED |

### 5.2 Ordinary receipt and provincial pharmacy cash memo

| Field | Proposed source | Official source / version / applicability | Status |
| --- | --- | --- | --- |
| Drug sale licence number | `BranchRegulatoryProfile.licenceNumber` | — | SIGN-OFF REQUIRED |
| Qualified person / pharmacist name or registration | `BranchRegulatoryProfile` | — | SIGN-OFF REQUIRED |
| Batch number and expiry per line | Dispensed lot | — | SIGN-OFF REQUIRED |
| Prescriber / prescription reference for scheduled drugs | Prescription fill | — | SIGN-OFF REQUIRED |
| Province-specific cash-memo wording (Sindh, DEV-100) | Jurisdiction rule set | — | SIGN-OFF REQUIRED |

### 5.3 FBR QR size conflict (SIGN-OFF REQUIRED)

The issue reports two conflicting FBR QR size specifications. This plan does not pick one.
Before any QR is rendered the adviser must record:

| Item | Value |
| --- | --- |
| Source URL | — |
| Publication / version date | — |
| Integration regime it applies to | — |
| Minimum printed dimensions | — |
| Quiet-zone requirement | — |
| Error-correction level | — |
| Scannability result on 58 mm, 80 mm and A4 (physical evidence pack) | — |

The only FBR source already cited in the repository is the FBR POS Integration booklet
(`https://download1.fbr.gov.pk/Docs/202551615541769POSBooklet.pdf`, 2025-05-16), used for Tier-1
criteria. Its applicability to receipt layout and QR size is **not verified**.

### 5.4 Open questions for the owner and adviser

1. Is each pharmacy customer Tier-1 for FBR POS integration, and from which date?
2. Which integrator regime and which official QR specification apply?
3. Which cash-memo fields are mandatory per province (Punjab, Sindh, KP, Balochistan, ICT)?
4. Must the fiscal block appear on A4 as well as thermal, and on reprints?
5. Is a buyer NTN/CNIC ever required on a retail pharmacy invoice?
6. What wording distinguishes an ordinary receipt from an FBR invoice when the integrator is off?

## 6. Acceptance criteria

1. A pharmacy admin can design a receipt per branch without any restaurant route or component.
2. Preview, browser print and thermal print render from the same model; 58 mm, 80 mm and A4
   previews wrap, align and paginate without clipping protected blocks.
3. English and Urdu (RTL) render correctly in the browser path; thermal falls back to the browser
   path for non-ASCII content.
4. No layout value can hide, alter, reorder away or overwrite a protected block; the server
   rejects such input even if the UI is bypassed.
5. The fiscal block is empty in `OFF` and `SANDBOX` modes; no FBR wording, logo or QR appears.
6. A branding QR is captioned as non-fiscal and never placed in the fiscal block.
7. Saving uses optimistic revision; a conflict shows the saved version and keeps the draft.
8. Changing a layout never changes a recorded amount, a receipt number or an issued original;
   reprints keep the reprint marking.
9. Branch and tenant isolation hold for read and save; saves are audited.
10. No fiscal field from section 5 is locked until section 9 is signed.

## 7. Test plan

Automated (vitest, no database where possible; database-backed suites follow the
`url ? describe : describe.skip` convention):

- Schema: v1 still parses; v2 rejects markup, control characters, bidi overrides, printer bytes,
  unknown keys, unsafe logo types and non-HTTPS branding QR URLs.
- Protected blocks: every layout permutation still renders legal identity, invoice identity,
  amounts, tax facts and reprint marking unchanged.
- Fiscal gate: `OFF` and `SANDBOX` documents (including `SANDBOX-` references) never produce fiscal
  output; layout input cannot inject a fiscal value.
- History: rendering a past sale with a new layout leaves stored sale facts and receipt number
  unchanged; reprint is a read.
- Router: non-admin save refused; cross-branch and cross-tenant ids refused; stale revision returns
  `CONFLICT`.
- Renderer parity: browser and ESC/POS block order match for the same input.

Manual and visual (Studio visual QA matrix): 58 mm, 80 mm, A4 × English, Urdu × light, dark ×
375/768/1440 widths; long medicine and branch names; empty optional sections.

Physical (only with the DEV-744 evidence pack): real thermal and A4 prints, logo legibility, and
FBR QR scannability at the signed-off size. A preview or automated test is never evidence of
physical or fiscal success.

## 8. Out of scope

- Implementation, migrations and UI code (separate ticket once approved).
- Live FBR submission, integrator selection, device or network access.
- Changes to existing PRs (#1378) or to the restaurant designer.

## 9. Owner/legal sign-off record

| Item | Signed by | Date | Source reviewed | Decision |
| --- | --- | --- | --- | --- |
| FBR-integrated invoice fields (5.1) | — | — | — | Pending |
| Ordinary receipt / cash-memo fields (5.2) | — | — | — | Pending |
| FBR QR size and quiet zone (5.3) | — | — | — | Pending |
| Fiscal data rule (3.4) | — | — | — | Pending |
