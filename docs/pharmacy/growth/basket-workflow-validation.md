# PR #792 basket workflow correction

The marketing workspace now calls basket mining with completed, numbered receipts from the
current organization and active branch. The server reads product eligibility and stores up to
three proposals per analysis in the existing immutable growth ledger, using the distinct
`DETERMINISTIC_BASKET` source. AI insight history excludes that source. Thresholds remain
configurable; no provider or AI setting is required.

The current active owner may approve their own proposal using their own active operator PIN.
The server resolves the staff profile from the session actor, locks the credential, and uses the
existing durable five-attempt/fifteen-minute lockout policy. Refused PINs return normally so
lockout updates commit. Raw review inputs are excluded from audit; `pinCredential` also receives
the audit serializer's credential redaction if authentication fails before the resolver.

Approval rechecks current product safety and creates a generic retail campaign draft together
with an append-only review containing actor, staff profile, PIN verification time, and campaign
lineage. It never stores the PIN. A proposal lock and the existing unique final-decision index
serialize replay. The campaign retains the existing approval, consent, frequency, quiet-hour,
capture, and dispatch gates. No database schema or policy changes are needed.

## Validation on 2026-10-31

This focused command passed **60 tests in six files**:

```sh
BASKET_VISUAL_OUTPUT=/tmp/devfathom-792-visual node node_modules/vitest/vitest.mjs run \
  src/server/routers/pharmacy-baskets.test.ts \
  src/server/routers/pharmacy-marketing.test.ts \
  src/lib/pharmacy/basket-analysis.test.ts \
  'src/app/(app)/pharmacy/marketing/actions.test.ts' \
  'src/app/(app)/pharmacy/marketing/page.test.tsx' \
  'src/app/(app)/pharmacy/marketing/basket-panel.test.tsx' \
  --maxWorkers=1 --no-file-parallelism
```

Router integration tests exercise the real mining, persistence and approval services with
database doubles and real bcrypt verification. Coverage includes owner-only access, current
actor/branch/lifecycle revocation, safety changes, missing/wrong/locked PINs, persisted lockout
updates, replay, rejection, bounded reads and untrusted-input refusal.

Studio visual QA used rendered panel fixtures and compiled `src/app/globals.css`, with the
existing local fonts and shared SectionCard, Input, Button, StatusPill and MarketingActionForm.
All **64 combinations** passed: 375/768/1024/1440px, light/dark, normal/reduced motion, and
pending/empty/error/rejected states. Checks covered visible content, keyboard focus and no
document overflow or page errors. Mobile axe WCAG A/AA checks passed in both themes for all
four states; eight pending-state screenshots and `matrix.json` were captured under
`/tmp/devfathom-792-visual`. Component tests cover loading/disabled feedback and preserved
values after review failure; existing page tests cover permission denial.

This is fixture browser evidence, not an authenticated live application or PostgreSQL run.
`TEST_DATABASE_URL` was unset. Prohibited heavy checks were left to the separate checks machine.
