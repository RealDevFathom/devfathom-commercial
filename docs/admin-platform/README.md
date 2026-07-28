# Admin Platform Documentation

This directory is the operating record for the proposed multi-tenant admin-platform expansion of DevFathom Hub. It is deliberately evidence-led: **Current** means verified in the repository on 2026-07-28; **Planned contract** is a target design, not shipped behavior; **Verification** is recorded only after a reproducible check.

| Area                     | Document                                          | Status            |
| ------------------------ | ------------------------------------------------- | ----------------- |
| Delivery ledger          | [STATUS](STATUS.md)                               | active            |
| Architecture and tenancy | [architecture-tenancy](architecture-tenancy.md)   | planned contract  |
| Product surfaces         | [control-plane](control-plane.md)                 | planned contract  |
| Domain model             | [data-model](data-model.md)                       | current + target  |
| Entitlements             | [entitlements](entitlements.md)                   | planned contract  |
| Commercial               | [commercial-ledger](commercial-ledger.md)         | planned contract  |
| Identity                 | [identity-access](identity-access.md)             | current + planned |
| APIs                     | [api](api.md)                                     | current + planned |
| Branding/domains/email   | [white-label](white-label.md)                     | planned contract  |
| Deployment/operations    | [operations](operations.md)                       | current + planned |
| Lifecycle                | [lifecycle](lifecycle.md)                         | planned contract  |
| Security                 | [security-threat-model](security-threat-model.md) | current + planned |
| Quality                  | [testing-release](testing-release.md)             | current + planned |
| Rollout                  | [migration-rollout](migration-rollout.md)         | planned contract  |
| Runbooks                 | [runbooks](runbooks.md)                           | planned contract  |
| Decisions                | [ADRs](adr/README.md)                             | active            |
| Change record            | [CHANGELOG](CHANGELOG.md)                         | active            |

## Source anchors

The existing application is Next.js 16/App Router, React 19, Prisma 7/PostgreSQL, NextAuth v5 and tRPC v11 (`package.json`; `README.md`). Core runtime anchors include `src/lib/auth.ts`, `src/server/trpc.ts`, `src/lib/api-auth.ts`, `prisma/schema.prisma`, and `src/app/api/v1/spec/route.ts`. Line references in these documents are navigation aids, not a substitute for source review.

## Documentation rules

Update STATUS and CHANGELOG with each delivery. A feature moves to Implemented only with a source anchor, and to Verified only with command, environment, date, and result. Do not infer production readiness from a dependency being present.
