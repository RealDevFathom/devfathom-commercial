[QA][Restaurants][SEV3] Restaurant tRPC errors include server stack traces
Labels: qa, restaurants, sev3-minor, security

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12 (`next dev`). Tenant `http://qa-karahi-essentials.localhost:3000`, signed in as the Essentials administrator. Executed 2026-10-21.

## Test case

UX-03. Observed on a correct business refusal (the Essentials location cap), not on a crash.

## Steps

1. Sign in as the Restaurant Essentials administrator.
2. Call the branch-create procedure for a second active branch (`PHASE2`).
3. Read the tRPC error JSON.

## Expected

The client receives HTTP 403 and the message `Your plan supports 1 active branch.` The body does not include a server stack, file paths, or chunk names.

## Actual

The procedure correctly returned HTTP 403 with that message, and the Essentials location cap itself passed as BRN-04. The error JSON also included `data.stack` beginning `TRPCError: Your plan supports 1 active branch.` followed by a stack frame under `/workspace/.next/dev/server/chunks/src_server_routers_1934tdm._.js`. The same `stack` field is present on other restaurant tRPC errors from this pass (loyalty module denied, agency catalog denied, staff validation).

Open issue #15 is raw Prisma error text in a 500 body. This is the tRPC error formatter attaching a stack to an intentional client error, and it is filed separately.

## Evidence

- `qa/restaurants/evidence/pos-rest.json` record `BRN-04` (HTTP 403, message, and `data.stack` with the workspace chunk path). The loyalty denial in the same file includes a stack as well.

## Suspected code

The tRPC error formatter in `src/server/trpc.ts`. No fix is proposed here.
