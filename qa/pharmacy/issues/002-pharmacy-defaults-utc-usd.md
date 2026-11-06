[QA][Pharmacy][SEV2] New pharmacy organization defaults to UTC and USD
Labels: qa, pharmacy, sev2-major, ux

## Environment

- Branch: `qa/pharmacy-restaurants-agencies`
- Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`
- Date: 2026-10-21
- App: `bun run dev --port 3000 --hostname 127.0.0.1` (Next.js 16.2.12)
- Host: `http://admin.localhost:3000`
- Operator: `qa-platform-admin@devfathom.test` (SUPER_ADMIN, TOTP enrolled)

## Test case

PH-GAP-02, observed while executing PH-SA-02

## Steps

1. Sign in to the platform control desk.
2. Open `/platform/organizations/new`.
3. Continue as Pharmacy.
4. Leave timezone and currency untouched and read the form.

## Expected

A Pakistan pharmacy form starts on `Asia/Karachi` and `PKR`. Restaurant and hospitality already default the timezone to `Asia/Karachi` in this same form.

## Actual

The untouched pharmacy form shows timezone `UTC` and currency `USD`. The province list is Pakistan (Punjab, Sindh, and the other territories), so the premises are a Pakistan launch while the commercial defaults are not.

QA overrode both fields to `Asia/Karachi` and `PKR` before creating `qa-clifton`. The saved organization kept those overrides. The defect is the default, not the save.

## Evidence

- `qa/pharmacy/evidence/gap-02-defaults.png`
- `qa/pharmacy/evidence/sa-02-pharmacy-form.png`
- `qa/pharmacy/evidence/results.json` (`PH-GAP-02`)

## Suggested code area

`src/app/platform/(console)/organizations/new/page.tsx`

- Currency field `defaultValue: 'USD'`.
- Timezone `defaultValue` is `Asia/Karachi` only when `vertical === 'RESTAURANT' || vertical === 'HOSPITALITY'`. Pharmacy falls through to `UTC`.

No fix is proposed here.
