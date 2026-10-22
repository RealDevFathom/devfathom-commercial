# Quality and performance

**Snapshot:** 2026-07-12 · branch `Design-1`  
**Scope:** verified quality baseline, exact lint inventory, proposed test/CI/performance/accessibility program, and the quality-gate definitions referenced by the [release checklist](../governance/RELEASE-CHECKLIST.md).

## Current baseline

All rows verified by running the listed command on 2026-07-12 unless noted.

| Check                          | Command                                           | Result                                                               |
| ------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------- |
| TypeScript                     | `bunx tsc --noEmit`                               | **Passing**                                                          |
| Lint                           | `bun run lint` (`eslint src/`)                    | **Failing** — 14 errors, 6 warnings                                  |
| Formatting                     | `bun run format:check` (Prettier 3.8.4)           | **Failing** — 70 source files reported on 2026-07-12                 |
| Unit / integration / E2E tests | —                                                 | **None exist** — no test files, no test framework, no `test` script  |
| CI                             | —                                                 | **None exists** — no `.github/workflows`, no other pipeline config   |
| Production build               | `bun run build` (`prisma generate && next build`) | **Passing** on 2026-07-12; Prisma generated and Next.js completed    |
| Dependency audit               | `bun audit`                                       | **Failing** — 1 critical, 2 moderate advisories                      |
| Migration gate                 | —                                                 | **None** — no `prisma/migrations` history; scripts use `db push`     |
| Lockfiles                      | —                                                 | Two tracked lockfiles: current `bun.lock`, stale `package-lock.json` |

## Exact lint failure inventory

**Verified** output of `eslint src/` on 2026-07-12 — 20 problems (14 errors, 6 warnings).

### Errors (14)

| File                                                           |           Line | Rule / diagnostic                                                      |
| -------------------------------------------------------------- | -------------: | ---------------------------------------------------------------------- |
| `src/app/(app)/email/oauth/callback/page.tsx`                  |             55 | `react-hooks/set-state-in-effect`                                      |
| `src/app/(app)/hr/hr-content.tsx`                              |            194 | `react/no-unescaped-entities`                                          |
| `src/app/(app)/hr/hr-content.tsx`                              | 740, 840, 1271 | `react-hooks/set-state-in-effect` (3 errors)                           |
| `src/app/(app)/meetings/meetings-content.tsx`                  |            612 | Impure function call during render                                     |
| `src/app/(app)/notes/notes-content.tsx`                        |            355 | `react-hooks/set-state-in-effect`                                      |
| `src/app/(app)/projects/[id]/board/[boardId]/kanban-board.tsx` |       330, 345 | React Compiler: existing memoization could not be preserved (2 errors) |
| `src/app/(app)/projects/[id]/board/[boardId]/kanban-board.tsx` |           1434 | `react-hooks/set-state-in-effect`                                      |
| `src/app/(app)/reviews/reviews-content.tsx`                    |       217, 603 | `react-hooks/set-state-in-effect` (2 errors)                           |
| `src/components/chat/composer/voice-recorder.tsx`              |            315 | `react-hooks/set-state-in-effect`                                      |
| `src/components/meetings/meeting-call.tsx`                     |             89 | `react-hooks/refs` — ref written during render                         |

### Warnings (6)

| File                                          | Line | Rule / diagnostic                                         |
| --------------------------------------------- | ---: | --------------------------------------------------------- |
| `src/app/(app)/finance/invoices-tab.tsx`      |   89 | React Compiler: compilation skipped, incompatible library |
| `src/app/(app)/hr/hr-content.tsx`             |  459 | React Compiler: compilation skipped, incompatible library |
| `src/app/(app)/meetings/meetings-content.tsx` |   67 | `react-hooks/exhaustive-deps` — missing `deleteMeeting`   |
| `src/lib/abac/policies.ts`                    |   17 | `@typescript-eslint/no-unused-vars` (`ALL_ACTIONS`)       |
| `src/lib/email/oauth.ts`                      |   50 | `@typescript-eslint/no-unused-expressions`                |
| `src/lib/email/providers/hosted.ts`           |   33 | `@typescript-eslint/no-unused-vars` (`_opts`)             |

### Failure categories and remediation direction

1. **Synchronous `setState` inside effects (9 errors).** The dominant pattern: dialog/form components re-initialize local state in `useEffect` when a prop changes. Fix by deriving state during render, keying the component on the changing identity, or using the state-initializer pattern — not by suppressing the rule.
2. **React Compiler conflicts (2 errors, 2 warnings).** Kanban memoization and two library-compatibility skips. Errors must be resolved so the compiler output remains predictable; the warnings should be documented if intentionally accepted.
3. **Render purity (2 errors).** An impure call during render (`meetings-content.tsx:612`) and a ref write during render (`meeting-call.tsx:89`). Both risk incorrect behavior under React 19 concurrent rendering.
4. **Hygiene (1 error, 4 warnings).** Unescaped entity, missing dependency, unused symbols/expressions — mechanical fixes.

**Proposed policy:** fix all 14 errors, then set lint as a blocking merge gate; warnings either fixed or individually annotated with a justification comment.

## Test strategy

**Verified:** the repository has no automated tests of any kind. Everything below is **Proposed**.

### Test pyramid

| Layer        | Tooling proposal                                | Scope                                                                                                                           | Target                                |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Unit         | Vitest                                          | Pure domain rules: invoice math and state machine, leave overlap, blocker-cycle detection, scope implication, redaction helpers | Fast, exhaustive edge cases           |
| Integration  | Vitest + ephemeral PostgreSQL (Docker) + Prisma | tRPC procedures via server-side caller: authorization, transactions, business rules                                             | The primary confidence layer          |
| API contract | Vitest + `fetch` against a running dev server   | `/api/v1` scopes, error envelopes, pagination, finance admin binding                                                            | Contract stability for scripts/agents |
| End-to-end   | Playwright                                      | Critical browser journeys against Preview                                                                                       | Small, stable, run pre-release        |

### Critical-path cases (first suite)

1. Login, session refresh, and `tokenVersion` revocation (sign-out-everywhere actually revokes).
2. ABAC/IDOR: employee cannot read finance, foreign projects, foreign DMs, other users' mailboxes, or audit logs.
3. Project→board→column→task lifecycle, including member-only assignee and same-board subtask rules.
4. Invoice integrity: server-side total recalculation, state-machine transitions, draft-payment rejection, overpayment rejection, payment currency inheritance.
5. Leave: overlap rejection, self-approval rejection, balance update on approval.
6. Note visibility: mention does not grant access; share grants exactly view/edit.
7. Chat: non-member cannot read/send; private DM has no admin bypass; attachment upload→send→authorized fetch→denied fetch (this test currently fails by design — see risk R-004).
8. Assistant: write tool re-authorizes; unauthorized tool call returns structured denial, not a write.
9. REST: missing scope → 403; expired/revoked token → 401; finance route with non-admin token → denied.
10. Webhooks: signature correctness; URL validation matrix (should fail today — R-006 documents the SSRF gap).

## CI design

**Proposed** pipeline (no CI exists today):

| Stage                    | Command                                           | Gate                                         |
| ------------------------ | ------------------------------------------------- | -------------------------------------------- |
| Install                  | `bun install --frozen-lockfile`                   | Blocking                                     |
| Generate                 | `bunx prisma generate`                            | Blocking                                     |
| Typecheck                | `bunx tsc --noEmit`                               | Blocking                                     |
| Lint                     | `bun run lint`                                    | Blocking after the baseline is cleared       |
| Format                   | `bun run format:check`                            | Blocking                                     |
| Unit + integration tests | `bun run test` (to be added)                      | Blocking                                     |
| Build                    | `bun run build`                                   | Blocking                                     |
| Dependency audit         | `bun audit`                                       | Blocking with documented-exception mechanism |
| Migration check          | `prisma migrate diff` against the target database | Blocking once migrations exist (R-002)       |
| E2E smoke                | Playwright against the Vercel Preview URL         | Blocking for production promotion            |

Branch protection on `main`: require green CI, at least one review, and no direct pushes. Production deploys promote a built Preview artifact rather than rebuilding (see [deployment and environments](../operations/DEPLOYMENT-ENVIRONMENTS.md)).

## Performance architecture

### Current state (Verified)

- Server-rendered route shells with interactive client islands (`*-content.tsx` pattern).
- Heavy components (assistant, command palette) are dynamically imported.
- TanStack Query caches tRPC reads; dashboards issue parallel queries.
- Long lists use `@tanstack/react-virtual`.
- Realtime fan-out is offloaded to Ably rather than app-held sockets.
- `pg.Pool` `max: 10` per function instance (`src/lib/db.ts`); the aggregate connection budget across concurrent instances versus the database plan limit is **unverified** — see risk register.
- Single region `sin1` co-locates compute near the primary team; database region co-location is assumed, not evidenced.

### Pressure points (Verified structure, Inferred impact)

- Large client modules concentrate bundle weight: Kanban board, chat composer, meeting call, HR console, Tiptap notes editor.
- Heavy dependencies in the client graph: Tiptap, Recharts, GSAP, Motion.
- No bundle-size monitoring, no Web Vitals/RUM collection, no query telemetry, no slow-request tracing.

### Route and bundle budgets (Proposed)

| Budget                                            | Target               | Enforcement                              |
| ------------------------------------------------- | -------------------- | ---------------------------------------- |
| Shared first-load JS                              | ≤ 130 KB gzip        | `next build` output diffed in CI         |
| Heaviest route first-load JS (board, chat, notes) | ≤ 300 KB gzip        | Bundle analyzer report per PR            |
| LCP (dashboard, P75)                              | ≤ 2.5 s              | Lighthouse CI on Preview                 |
| INP (board interactions, P75)                     | ≤ 200 ms             | Lighthouse CI / RUM once collected       |
| tRPC read procedures (P95)                        | ≤ 400 ms server time | Metrics once observability lands (R-008) |
| `/api/v1` responses (P95)                         | ≤ 500 ms             | Same                                     |

Budgets are starting points to be re-baselined against real measurements; the discipline (any regression needs an explanation) matters more than the initial numbers.

## Accessibility and browser testing

**Current state (Verified):** interactive primitives build on `@base-ui/react`, which supplies focus and ARIA behavior; semantic design tokens define color. No automated accessibility checks, no documented browser matrix, no manual audit evidence.

**Proposed:**

- WCAG 2.1 AA as the target for core flows (login, dashboard, tasks, leave, invoices).
- axe checks inside Playwright E2E for each critical journey.
- Keyboard-only pass for dialogs, Kanban drag-and-drop alternatives, and the command palette.
- Contrast verification of the token palette in both light and dark themes.
- Browser matrix: last two versions of Chrome, Firefox, Safari, and Edge; mobile Safari and Android Chrome as smoke-only.

## Dependency management

### Current state (Verified)

- Bun 1.3.x is the package manager and script runner; no `engines` field constrains Node/Bun versions.
- `bun audit` advisories: critical `shell-quote` (via dev-only `concurrently`), moderate `@hono/node-server` (via `shadcn`/`prisma` tooling), moderate `postcss` (via the CSS toolchain).
- Legacy dependencies remain installed although no code path is started that uses them: `socket.io`, `socket.io-client`, `express`, `cors`, `jsonwebtoken`, `@ai-sdk/groq`, `concurrently`. The `socket-server/` directory referenced by the root README does not exist.
- Two lockfiles are tracked; `package-lock.json` pins older Next/React/Prisma versions than `bun.lock`.

### Policy (Proposed)

1. Single lockfile: keep `bun.lock`, delete `package-lock.json`, and add a CI guard against reintroduction.
2. Remove legacy dependencies in one reviewed cleanup after grep-verifying no imports remain.
3. `bun audit` runs in CI; a red audit blocks release unless a documented exception with expiry exists.
4. Monthly dependency-update window; framework majors (Next, Prisma, React) get their own upgrade PR with the relevant migration guide read first (`node_modules/next/dist/docs/` per `AGENTS.md`).
5. Add an `engines`/`packageManager` declaration so local, CI, and Vercel resolve identically.

## Quality gate definitions

| Gate      | Green means                                  | Current state                   | Applies to                          |
| --------- | -------------------------------------------- | ------------------------------- | ----------------------------------- |
| Typecheck | `bunx tsc --noEmit` exits 0                  | Green                           | Every merge                         |
| Lint      | `bun run lint` exits 0                       | **Red** (14 errors)             | Every merge, after baseline cleanup |
| Format    | `bun run format:check` exits 0               | **Red** (70 source files)       | Every merge                         |
| Tests     | All suites pass; critical-path suite exists  | **Absent**                      | Every merge                         |
| Build     | `bun run build` exits 0                      | **Green** (verified 2026-07-12) | Every merge                         |
| Audit     | `bun audit` clean or excepted                | **Red** (1 critical)            | Release                             |
| Migration | Committed migrations apply cleanly; no drift | **Absent**                      | Any schema-change release           |
| Smoke     | Preview E2E passes                           | **Absent**                      | Production promotion                |

Per the [release checklist](../governance/RELEASE-CHECKLIST.md), no production release proceeds while a gate is red unless a signed risk acceptance from the [risk register](../executive/RISK-REGISTER.md) covers it.

## Related documents

- [Engineering handbook](ENGINEERING-HANDBOOK.md) — conventions and safe-change workflow.
- [Release checklist](../governance/RELEASE-CHECKLIST.md) — evidence required per release.
- [Risk register](../executive/RISK-REGISTER.md) — R-002 (migrations), R-007 (tests/CI), R-009 (lint), R-012 (advisories), R-013 (lockfiles).
- [Experience and accessibility](../product/EXPERIENCE-ACCESSIBILITY.md) — WCAG 2.2 AA target, interaction standards, critical journeys, and design QA gate.
