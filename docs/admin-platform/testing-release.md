# Testing and Release Gates

## Current tooling

`package.json` provides lint, build, Prisma generation, assistant evaluation/diagnostics and email smoke scripts. Playwright and Vitest dependencies are present. Do not claim a test suite runs until a command result is recorded.

## Release gates (planned)

1. Type/build/lint pass.
2. Migration applies and rolls back safely on representative data.
3. Tenant isolation matrix passes for REST, tRPC, UI, jobs, files and exports.
4. Authorization/entitlement negative tests pass.
5. OIDC/SAML/SCIM protocol tests pass when enabled.
6. Domain, email, billing/webhook and lifecycle integration tests pass in preview/staging.
7. Backup restore and incident runbook drills meet RPO/RTO.
8. Security review, threat-model update and release approval are recorded.

Attach actual CI URLs, command output references, environment and date to STATUS before release.
