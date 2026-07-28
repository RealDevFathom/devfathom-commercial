# API Inventory and Conventions

## Current inventory

| Surface                | Anchor                                                                       | Notes                                    |
| ---------------------- | ---------------------------------------------------------------------------- | ---------------------------------------- |
| tRPC                   | `src/app/api/trpc/[trpc]/route.ts`, `src/server/trpc.ts`                     | session/context procedures               |
| REST v1 spec           | `src/app/api/v1/spec/route.ts`                                               | source of documented REST operation list |
| Invoice REST           | `src/app/api/v1/invoices/route.ts`                                           | existing application resource            |
| Assistant/upload/files | `src/app/api/assistant/route.ts`, `upload/route.ts`, `files/[name]/route.ts` | separate application APIs                |
| API auth               | `src/lib/api-auth.ts`                                                        | scoped token helper                      |

## Planned conventions

Version externally supported endpoints under `/api/v1`; publish OpenAPI generated or checked against implementation. Require authentication, tenant resolution from host/token binding, scoped authorization, request IDs, structured errors, cursor pagination, ISO-8601 timestamps, and idempotency keys for externally retried writes. Never accept `organizationId` as authority when the credential/host resolves a different tenant.

Deprecations require a documented sunset date, compatibility window and changelog entry.
