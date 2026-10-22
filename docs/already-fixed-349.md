# GitHub issue #349 was already fixed

Issue #349 reported an inverted prescription-capture authorization gate: a cashier with
`pharmacy:orders` could load and use the capture/upload workflow, while a tenant administrator
without capability rows could not.

The current code already has the intended behavior, so no production or test code was changed:

- `src/server/routers/pharmacy-prescriptions.ts:40-59` defines the shared file procedure. It
  requires the `pharmacy-dispensing` module and a central ABAC decision for the exact
  `pharmacy:dispense` action; `pharmacy:orders` is not an alternative.
- `src/server/routers/pharmacy-prescriptions.ts:90-98` applies that procedure to `workspace`.
  Consequently, an unauthorized cashier cannot obtain the workspace data that enables the
  capture form.
- `src/components/pharmacy/dispensing/prescriptions-console.tsx:262-271` renders an error for a
  failed workspace request and renders the capture form only when `workspace.data` exists.
- `src/lib/abac/policies.ts:237-243` supplies tenant administrators' default
  `pharmacy:dispense` policy through the central ABAC engine rather than bypassing it.
- `src/lib/abac/index.ts:48-57` evaluates matching override and organization-role `DENY` rules
  before `ALLOW` rules, and `src/lib/abac/index.ts:78-87` returns a custom decision before trying
  the administrator policy. Thus an explicit deny continues to override the administrator
  fallback.
- `src/lib/abac/capabilities.ts:7-26` keeps `pharmacy:dispense`, `pharmacy:safety`, and
  `pharmacy:catalogue-review` exact-grant-only for capability rows while preserving wildcard
  denies.
- `src/server/routers/pharmacy-prescriptions.test.ts:187-234` contains focused regression
  coverage for a pharmacist, an allowed tenant administrator, an explicitly denied tenant
  administrator, and a cashier who has only `pharmacy:orders`. The cashier is refused both the
  workspace and upload before storage is called.

This issue is not an archive-recovery request, so there was no archive branch to diff or port.
