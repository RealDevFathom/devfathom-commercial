# GitHub issue #423: already fixed

Issue #423 reports that the Pharmacy sidebar is not role-specific. The current code already fixes
the reported behavior, so no implementation change is needed.

## Current-code evidence

- `src/components/layout/sidebar.tsx:317-359` gates Day close to admins and gates Counter,
  Inventory, Purchasing, and Reports & Insights with their corresponding pharmacy or reporting
  capabilities.
- `src/components/layout/sidebar.tsx:386-415` gates Prescriptions, Pharmacist queue,
  Substitution, and Controlled register with their corresponding capabilities.
- `src/components/layout/sidebar.tsx:547-583` applies module, vertical, pharmacy capability,
  all-capabilities, and admin filters before returning visible navigation. Capability checks are
  fail-closed when a required capability is absent.
- `src/components/layout/sidebar.test.ts:153-225` contains focused role-matrix coverage. In
  particular, the Cashier fixture sees Counter and Prescriptions, while the shared assertion
  excludes Day close; Purchasing, Reports, Pharmacist queue, and Substitution are absent from the
  Cashier's exact expected route list.
- `src/components/layout/sidebar.test.ts:227-260` verifies that wildcard ownership does not expose
  the exact-grant-only pharmacist and safety destinations.

The existing implementation was introduced by commit
`c40ab4fccd0d27de2c814fc3eb7480ac9bd315e5` (`fix(#423): codex (verify-first) off main`).

