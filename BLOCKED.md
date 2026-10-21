# Status (CTO, 2026-10-21)

Resolved:
- QA138 UI: the controlled authorization panel is hidden when controlledPharmacists is FORBIDDEN
  (actor lacks dispense/safety). counter-console tests render a marker from the panel mock and
  cover cashier-hidden / dispenser-shown.
- Model/migration alignment: PharmacyBranchAssignment copied from #107; 20261021150000 removed.
  MERGE ORDER: #107 into integration first, then merge integration into this branch.
- Typecheck clean (witness-enumeration test typing fixed).

Still open: full pharmacy DB integration suites on the whole migration chain; browser QA retest of #138.

## PLATFORM daily QA — #165 (2026-10-21)

Deferred using the explicitly authorized CSP fallback. The installed Next 16.4.2
CSP guide requires every nonce-protected page to render dynamically. The root
layout and PreferenceBootstrap currently emit scripts without request nonces;
changing the policy alone would break hydration. A safe rollout needs request
nonce propagation, dynamic rendering across all routes, and production browser
coverage. Production builds are excluded from this shared-box batch. Keep the
existing script policy for now; address the Zod eval violation separately (#166).
