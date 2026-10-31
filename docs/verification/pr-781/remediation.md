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

| Matrix | Status |
| --- | --- |
| 375 / 768 / 1024 / 1440 px, bounded overflow | Not run |
| Light / dark themes | Not run |
| Normal / reduced motion | Not run |
| Keyboard order, visible focus, zoom/reflow | Not run |
| Loading, empty, error, disabled, success and denied states | Runtime verification pending |
| Console / hydration / accessibility errors | Not run |

Source review confirms reuse of Studio PageHeader, SectionCard, Input, Button and semantic tokens.
No runtime or visual pass is claimed.
