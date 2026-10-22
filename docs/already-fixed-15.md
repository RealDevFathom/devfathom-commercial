# GitHub issue #15 is already fixed

Verified against the current `work` branch on 2026-10-22. The reported raw Prisma error
disclosure is already covered by the existing implementation, so no application code was
changed for this issue.

## Evidence

- `src/server/trpc.ts:88-102` maps Prisma `P2025`, `P2002`, and `P2003` failures to stable,
  user-facing messages and the corresponding tRPC and HTTP status codes.
- `src/server/trpc.ts:143-151` recognizes `PrismaClientKnownRequestError` instances and withholds
  every unrecognized Prisma failure rather than passing its original message to the client.
- `src/server/trpc.ts:155-168` removes server stacks, replaces mapped Prisma response metadata,
  and selects the safe mapped or generic message for the response.
- `src/server/routers/clients.ts:284-288` guards `clients.update` with a tenant-scoped lookup and
  throws `NOT_FOUND` with `Client not found` before attempting the update.
- `src/server/trpc-error-formatter.test.ts:88-110` supplies representative stale-update, unique,
  foreign-key, and unknown Prisma errors containing internal ORM details.
- `src/server/trpc-error-formatter.test.ts:137-157` asserts a stale update becomes `NOT_FOUND` / HTTP
  404, verifies mapped responses contain no Prisma invocation or model/constraint detail, and
  verifies unknown Prisma failures receive the generic message.
- `src/server/trpc-error-formatter.test.ts:159-165` preserves the existing friendly Zod validation
  behavior instead of stripping all error messages.

The existing global formatter also protects unguarded stale-record writes in the other routers:
Prisma reports those failed `update()` / `delete()` operations as `P2025`, which the formatter
maps to the safe 404 response above. The focused client guard provides the entity-specific message
for the reproduction in the issue while retaining the scoped database boundary.

This issue is not a “Recover work from `archive/...`” request, so no archive branch diff or port was
needed.
