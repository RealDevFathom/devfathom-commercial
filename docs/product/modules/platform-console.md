# Platform console

## Requirement

- **IMPLEMENTED** — Separately authorized platform pages cover overview, organizations/onboarding records, operators, catalog, commercial ledger, CRM, deployments, jobs, audit, and settings. Evidence: [`src/app/platform/(console)`](../../../src/app/platform/%28console%29), [`src/app/api/platform/control/route.ts`](../../../src/app/api/platform/control/route.ts), [`docs/admin-platform/control-plane.md`](../../admin-platform/control-plane.md).
- **IMPLEMENTED** — Packages/modules/entitlements and lifecycle controls are represented in platform data and service boundaries. Evidence: [`src/lib/module-catalog.ts`](../../../src/lib/module-catalog.ts), [`docs/admin-platform/entitlements.md`](../../admin-platform/entitlements.md), [`tests/production-bootstrap.test.ts`](../../../tests/production-bootstrap.test.ts).

## Acceptance and boundary

- Platform access remains distinct from tenant membership; privileged changes are audited and tenant runtime does not depend on control-plane availability. Evidence: [`docs/admin-platform/adr/002-control-plane-separation.md`](../../admin-platform/adr/002-control-plane-separation.md), [`src/app/platform/(console)/audit/page.test.tsx`](../../../src/app/platform/%28console%29/audit/page.test.tsx).
- **PLANNED (Lane C)** — Platform login/onboarding completion. Existing [`src/app/platform/(auth)/login`](../../../src/app/platform/%28auth%29/login) is partial evidence, not Lane C acceptance.
- **PLANNED (WHA-212)** — Both-console camera setup wizard.
