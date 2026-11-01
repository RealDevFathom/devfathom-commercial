# PR #781 review remediation

- The report advice loader now reads recorded sales/unrecovered demand, effective pack conversions,
  valid supplier quotes/licences, approved inbound, safety stock, equivalent stocked medicines and
  other branches' surplus. Draft quantities use the selected distributor's scheme and MOQ.
- Report access requires operational capability and the reports entitlement. Financial advice
  additionally requires financial capability. Writes recheck the current database actor's relevant
  procurement/inventory capability, including wildcard grants and explicit denials.
- The production boundary verifies the actor's own operator PIN in a separate committed transaction
  so failed-attempt counters survive refusals. Advice changes invalidate its fingerprint. The native
  draft and decision audit commit together in a serializable tenant transaction.
- Branch trigger settings are persisted and validated. Counter visit capture records one explicit,
  idempotent visit outcome; SKU/salt walk-outs use recorded branch visits in the request window.
  Partial capture is labelled and is never inferred from searches or abandoned carts.
- Purchase drafts use the existing submission/approval workflow. Transfer proposals require explicit
  source-branch submission with stock/surplus revalidation before the existing second-person approval.
  Drafting and submission do not move or reserve stock.
- The original report-page fixture is updated; filter/header assertions are retained. Added coverage
  includes actual database drafts/audits/PIN counters/approval/RLS, authorization, settings, visit rates,
  distributor-specific quantities, and UI access/empty/error states. PIN fields are audit-redacted.

## Verification status

No tests, typecheck, lint, build, security checks or migrations were run locally, per the user's
strict checks-machine instruction. Machine C must verify the new commit; the supplied prior report
only covers 22d1935860b146da36f09583e4d634fec92c7fa2.

Runtime visual QA is pending for reports, counter visits and transfer draft submission:

| Matrix                                                     | Status                       |
| ---------------------------------------------------------- | ---------------------------- |
| 375 / 768 / 1024 / 1440 px, bounded overflow               | Not run                      |
| Light / dark themes                                        | Not run                      |
| Normal / reduced motion                                    | Not run                      |
| Keyboard order, visible focus, zoom/reflow                 | Not run                      |
| Loading, empty, error, disabled, success and denied states | Runtime verification pending |
| Console / hydration / accessibility errors                 | Not run                      |

Source review confirms reuse of Studio PageHeader, SectionCard, Input, Button and semantic tokens.
No runtime or visual pass is claimed.

## Review round: draft payloads, pharmacy PIN enrolment, lint

- **Draft payloads (P1).** Nested purchase-order and transfer line creation no longer passes
  `organizationId`; Prisma derives it from the composite parent relation. The equivalent nested
  licence, requisition-line and quote-line fixtures in `lost-demand-operations.db.test.ts` were
  repaired the same way, and a duplicated `support` key in the caller context was removed.
- **Pharmacy PIN enrolment (P1, decision Q2 option A).** New `pharmacyOperatorPin` router
  (`setPin`, `status`), licensed by `pharmacy-core` (never `restaurant-core`), and the
  `/pharmacy/settings/pin` screen. Only holders of `pharmacy:manage` (Owner, Owner / Operator,
  Manager templates) may enrol, and only for an active owner/manager in the same organization.
  An owner may set or reset any owner/manager PIN; a manager may set their own first PIN and must
  prove the current PIN to change it (failed attempts commit to the durable lockout counter).
  The PIN is stored only as the salted slow hash on the operator-credential row that
  `verifyLostDemandPin` checks; a reset revokes the previous PIN. The plaintext PIN is never
  returned, logged or audited: the middleware audit skips input and the in-transaction
  `PHARMACY_OPERATOR_PIN` audit row carries identifiers only. Suspended/archived profiles are not
  reactivated. The mutation is blocked in demo tenants, matching `restaurantStaff.issueCredential`.
  The lost-demand workflow links to the PIN screen. No schema change was needed.
- **Lint (P2).** `module` in `actOnLostDemandAdvice` renamed to `requiredModule`.
- **Merge.** `origin/develop` merged; conflicts in `module-catalog.ts`, `audit.ts`,
  `pharmacy-reports.ts` and `pharmacy-reports.test.ts` resolved keeping both sides.

Runtime visual QA of `/pharmacy/settings/pin` (viewports, themes, motion, keyboard, states,
console) is pending, like the matrix above. Source review: reuses PageHeader, SectionCard, Input,
Label, Button, StatusPill and semantic tokens; 44px controls; visible labels, `aria-invalid`,
`role="alert"` errors; permission-denied state rendered in the same card geometry.
