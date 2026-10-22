# Documentation and diligence validation report

**Snapshot:** 2026-07-12  
**Branch / baseline:** `Design-1` / `aae58c6` plus preserved local UI redesign changes  
**Scope:** documentation atlas, repository facts used by the atlas, selected security/business-rule evidence, build/quality state, linked Vercel names/status, and repository integrity.

## Outcome

The documentation set is complete and internally linkable. Repository counts were deterministically re-verified. TypeScript and the production build pass. Lint, source formatting, dependency audit, automated tests, CI, and migration gates remain red or absent and are explicitly carried as risks.

No application source file was changed during documentation closeout. Existing UI redesign changes and unrelated user artifacts were preserved. No commit or push was performed.

## Validation matrix

| Check                      | Command/method                                              | Result                           | Interpretation                                                                                                    |
| -------------------------- | ----------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Branch/baseline            | `git branch --show-current`, `git rev-parse --short HEAD`   | `Design-1`, `aae58c6`            | Snapshot identity confirmed                                                                                       |
| TypeScript                 | `bunx tsc --noEmit`                                         | **Pass**                         | Static typecheck green                                                                                            |
| Production build           | `bun run build`                                             | **Pass**                         | Prisma 7.8.0 generated; Next.js 16.2.10 compiled/typechecked; 35 static pages generated and dynamic routes listed |
| ESLint                     | `bun run lint`                                              | **Fail: 14 errors, 6 warnings**  | Existing React correctness/compiler and smaller hygiene findings remain release-red                               |
| Source formatting          | `bun run format:check`                                      | **Fail: 70 source files**        | Existing source formatting baseline is red; no bulk source rewrite was performed                                  |
| Atlas formatting           | Prettier write/check on all atlas Markdown plus root README | **Pass after formatting**        | Documentation syntax/layout normalized; historical `docs/superpowers` material preserved                          |
| Dependency audit           | `bun audit`                                                 | **Fail: 1 critical, 2 moderate** | `shell-quote`, `@hono/node-server`, `postcss` advisories remain open                                              |
| Automated tests            | conventional filename and package-script scan               | **Absent**                       | No unit/integration/E2E suite or `test` script                                                                    |
| CI                         | workflow/config scan                                        | **Absent**                       | No GitHub Actions or alternative CI gate                                                                          |
| Prisma migrations          | directory/config scan                                       | **Absent**                       | No checked-in `prisma/migrations` history                                                                         |
| Relative links and anchors | Markdown parser over root README + atlas                    | **Pass: 0 broken**               | File and heading targets resolve locally                                                                          |
| Secret-like patterns       | targeted patterns across atlas, README, `.env.example`      | **Pass: 0 matches**              | No detected API keys/private keys/token/credential URL patterns; not a substitute for a dedicated scanner         |
| Patch whitespace           | `git diff --check`                                          | **Pass**                         | No whitespace/conflict-marker errors in tracked diff                                                              |
| Risk/decision references   | extracted IDs compared with registers                       | **Pass**                         | Every referenced `R-*`, `D-*`, and `OD-*` is defined                                                              |
| Existing UI preservation   | `git status`, scoped diff review                            | **Pass**                         | Documentation work did not overwrite listed UI redesign files                                                     |

## Deterministic repository counts

| Measure                          | Verified value | Counting rule                                                                             |
| -------------------------------- | -------------: | ----------------------------------------------------------------------------------------- |
| TypeScript/TSX/Prisma lines      |         69,221 | `src`, `prisma`, `scripts`; generated Prisma excluded                                     |
| Non-generated `src` TS/TSX files |            259 | filesystem count, generated client excluded                                               |
| Prisma models                    |             60 | lines beginning `model ` in `prisma/schema.prisma`                                        |
| Prisma enums                     |             23 | lines beginning `enum ` in `prisma/schema.prisma`                                         |
| Composed tRPC domains            |             20 | keys in `src/server/routers/_app.ts`                                                      |
| Router files                     |             22 | `src/server/routers/*.ts`; `_app.ts` and `chat-helpers.ts` contain no procedure terminals |
| tRPC procedures                  |            229 | `.query(`/`.mutation(` terminals in router files                                          |
| REST v1 route files              |             16 | `src/app/api/v1/**/route.ts`                                                              |
| Assistant tools                  |             96 | `tool({` declarations in `src/lib/ai/tools/*.ts`                                          |
| Tool factories                   |             10 | files in `src/lib/ai/tools/*.ts`                                                          |
| Approval-gated tools             |             60 | anchored `needsApproval: true` definition properties; comments/usages excluded            |
| Webhook event types              |              2 | `WEBHOOK_EVENTS`: `invoice.paid`, `task.created`                                          |
| Atlas Markdown files             |             29 | excludes historical `docs/superpowers/**`                                                 |

## Resolved dependency versions

Verified from installed package metadata and `bun.lock`:

| Package           | Resolved |
| ----------------- | -------- |
| Next.js           | 16.2.10  |
| React / React DOM | 19.2.7   |
| Prisma / client   | 7.8.0    |
| tRPC server       | 11.17.0  |
| AI SDK            | 6.0.207  |
| Base UI           | 1.5.0    |

`package.json` declares compatible ranges for several dependencies, while the stale tracked `package-lock.json` contains older divergent versions. `bun.lock` is the operational source under D-010, but the alternate lock remains risk R-013.

## Sampled implementation evidence

| Claim sampled                         | Evidence                                                                                                   | Result                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| tRPC denies inactive accounts         | `src/server/trpc.ts::assertActive` uses `ACTIVE_STATUSES` and throws `FORBIDDEN`                           | Confirmed                                                        |
| REST scopes/user binding/finance gate | `src/lib/api-auth.ts::withApiAuth` authenticates, throttles, checks scopes, and requires ADMIN for finance | Confirmed; limiter is per-instance and audit detached            |
| Webhook SSRF                          | `src/lib/webhooks.ts::deliver` fetches configured URL with default redirect behavior and no address guard  | Confirmed                                                        |
| OAuth state generated                 | `src/lib/email/oauth.ts::buildConsentUrl` includes provided state                                          | Confirmed; no persisted/consumed expected state in callback flow |
| Microsoft ID token verification gap   | `decodeJwtPayload` base64-decodes JSON without signature/claim verification                                | Confirmed                                                        |
| Upload storage and URL                | `/api/upload` writes `private-uploads` and returns `/api/files/<name>`                                     | Confirmed                                                        |
| Direct-route status gap               | Assistant/upload/file/Ably routes require session user ID but do not call tRPC `assertActive`              | Confirmed                                                        |
| Assistant controls                    | `/api/assistant` builds session context, selects tools, caps at six steps                                  | Confirmed; no explicit body/schema/rate/cost gate                |
| Approval count                        | anchored property count across 96 tool definitions                                                         | 60 confirmed; earlier 66/68 claims corrected                     |
| Detached REST audit                   | `recordRestAudit` launches a `void` async IIFE                                                             | Confirmed durability risk                                        |
| Business-rule catalogue               | targeted graph/text review across finance/team/projects/notes/chat routers                                 | Rules are represented; automated regression evidence is absent   |

## Linked Vercel inspection

Read-only checks used `.vercel/project.json`, `vercel whoami`, `vercel env ls`, `vercel ls`, and `vercel inspect dev-fathom-hub.vercel.app`.

Verified names/status only:

- linked project `dev-fathom-hub` under the expected account/team;
- recent Preview and production-target deployments Ready; historical Production errors exist;
- Production/Preview/Development environment-name parity is incomplete;
- Development has no listed variables;
- Gemini and JaaS names exist in Production but not Preview;
- mailbox OAuth/encryption names are absent;
- legacy Socket.IO and Groq names remain deployed;
- canonical alias resolves to a Ready 2026-06-24 deployment while newer Ready production-target deployments exist.

No environment value was read, copied, or written. No deployment, alias, variable, or project setting was changed.

## Known red checks

### Lint

The 14 errors and 6 warnings include:

- synchronous state updates inside effects;
- impure `Date.now()` during render;
- React Compiler/manual-memo dependency mismatches;
- ref mutation during render;
- a missing hook dependency;
- an unescaped entity;
- smaller unused/no-expression warnings.

Exact files/lines remain in [quality and performance](../engineering/QUALITY-PERFORMANCE.md).

### Formatting

Prettier reports 70 application source files. This is intentionally not auto-fixed in the documentation task because a repository-wide rewrite would mix with user-owned redesign work and obscure behavioral review.

### Dependency audit

- Critical: `concurrently` → `shell-quote`.
- Moderate: tooling paths to `@hono/node-server`.
- Moderate: toolchain paths to `postcss`.

### Missing gates

- no tests;
- no CI;
- no migration history;
- no automated preview smoke;
- no observability/alert evidence;
- no restore exercise.

## Limitations

1. Graph indexing was ready and used first, but complex/property coverage is not equivalent to full semantic verification of every resolver.
2. Evidence sampling does not replace a line-by-line security review or test suite.
3. Secret pattern scans can miss novel formats; use a dedicated secret scanner in CI.
4. Ready deployments prove successful build/deployment state, not functional correctness or availability.
5. Environment inspection covered names/scope, never values or validity.
6. Vendor contracts, backups, platform access/MFA, corporate/legal/financial records, and customer/employee evidence are outside the repository.
7. Product strategy, RACI, privacy, continuity, SLO, and release policies remain Proposed until accepted.

## Reproduction and maintenance

Re-run this report quarterly, before external diligence, after a major framework/vendor/security/data change, and after any incident. Update the snapshot date, commands, counts, live-state evidence, risk closures, and limitations. Do not overwrite prior external evidence; preserve dated copies in the controlled data room.

## Related documents

- [Project status](../executive/PROJECT-STATUS.md) · [Technical due diligence](../executive/TECHNICAL-DUE-DILIGENCE.md) · [Risk register](../executive/RISK-REGISTER.md) · [Diligence data-room index](../executive/DILIGENCE-DATA-ROOM-INDEX.md) · [Glossary/source map](GLOSSARY-SOURCE-MAP.md)
