# RESUME — QA Remediation + Enhancement Program (DevFathom-Hub)

> Handoff for continuing after a context clear. Branch: **`fix/qa-remediation`**.
> Repo: **`WhatTheStack1/DevFathom-Hub`** (gh authed as WhatTheStack1).
> Read `/FIXES.md`, `/ENHANCEMENTS.md`, `/TICKETS.md`, `CLAUDE.md`, `AGENTS.md` first.

## Where it stands (as of last session — 42 commits on the branch)
- **Bugs: 52/53 done.** All HIGH (3) + 21/22 MEDIUM + 28/28 LOW fixed, verified, committed,
  cards → Done, GitHub issues closed with evidence (milestone "QA Remediation").
  - **AUTH-01 (#27) = BLOCKED on a DB migration** (needs `passwordChangedAt`/`tokenVersion` column).
    Issue open; card in In Progress; ready-to-apply 6-step plan in `/FIXES.md`. Escalated.
- **Enhancements: 70 filed in both trackers** (milestone "Product Improvements" + internal
  "Improvements" board). **40 implemented (closed), 6 partial, 15 to-build, 9 planned (Big Bets).**
- **Build (`bun run build`) + `src/` typecheck GREEN** at every step.
- **Keystone NEVER modified** — `src/lib/abac/**` and `src/lib/authz.ts` have zero diff across all
  42 commits (verify: `git diff --stat ebd2c41..HEAD -- src/lib/abac src/lib/authz.ts` → empty).

## NON-NEGOTIABLE constraints (carry forward)
- **NO schema/mutating ops against the shared remote Neon DB** (`DATABASE_URL`). The ONLY allowed
  shared-DB write is **ticket status moves** on the internal board. For anything needing a migration
  (new column/table), stand up a **local disposable Postgres** (point DATABASE_URL at it,
  `bunx prisma db push`, seed) — never migrate the shared DB. (Last session: no local Postgres
  installed, Docker daemon was down.)
- Keep the keystone intact (add restrictions, never loosen). Build + typecheck green each phase.
- `scripts/` are Bun-run and excluded from the Next typecheck via `tsconfig.json` (they use
  `import.meta.dir`). Don't "fix" that by re-including them.

## Tooling / how to reconcile trackers (IMPORTANT — this is the loop)
- **Bug → Done:** implement (root cause) → `bun run build` + `bunx tsc --noEmit` green →
  `bun scripts/qa-move-cards.ts Done <BUG-ID>` → `gh issue close <#> --repo WhatTheStack1/DevFathom-Hub --comment "<evidence>"` →
  add entry to `/FIXES.md`. Commit per-ticket referencing the BUG-ID/issue#.
- **Enhancement → done:** edit `scripts/enhancements.json` (set the item's `status` to
  `implemented` | `partial`), then **`bun scripts/file-enhancements.ts`** (idempotent: refreshes all
  70 issues, closes newly-implemented, moves internal cards, **regenerates `/ENHANCEMENTS.md`**),
  then `rm -f scripts/.enh-*.md` and commit `ENHANCEMENTS.md` + `enhancements.json`.
- Status taxonomy in `enhancements.json`: `implemented` (closed/Done), `partial` (In Progress),
  `todo` (To Do), `planned` (Big Bets → also gets `needs-greenlight` label if tier `big-bet`).
- `bun scripts/lint-tool-schemas.ts` — Groq-schema regression guard (must stay 96 checked / 0 violations).
- Co-author trailer on commits: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## PENDING DECISION (was awaiting user a/b/c). Default on "continue" = (a).
- **(a) Heavier schema-free Mediums (no greenlight needed, do now):**
  - `IMP-PROJ-08` Bulk task actions (multi-select move/label/assign/delete) — UI-heavy.
  - `IMP-PROJ-09` Board pagination / lazy-load (`getBoardWithTasks` reworks data flow — careful).
  - `IMP-REST-01` Per-token usage metrics (needs audit↔token linkage; rate-limiting already done).
  - `IMP-AI-02` Streaming citations / surface assistant writes in audit.
- **(b) AUTHORIZE A DB MIGRATION → unlocks 11 schema-blocked Mediums + AUTH-01 + AUTH-03:**
  `IMP-PROJ-06` subtasks/deps, `IMP-PROJ-07` WIP limits, `IMP-CLI-05` contract↔project link,
  `IMP-FIN-03` recurring-expense posting, `IMP-FIN-04` partial payments, `IMP-DASH-02` widget prefs,
  `IMP-AUTH-04` notification prefs, `IMP-RT-02` message edit-history, `IMP-HR-04` performance reviews,
  `IMP-NOTE-02` note @mentions, `IMP-RT-05` per-channel attachment auth. Plus `AUTH-01` + `IMP-AUTH-03`.
- **(c) GREENLIGHT Big Bets (filed `needs-greenlight`, each has a plan in its issue):**
  `IMP-FIN-01` invoice edit+PDF+email, `IMP-PROJ-01` time tracking, `IMP-NOTE-01` note versioning,
  `IMP-HR-01` leave balances+calendar, `IMP-AUTH-02` 2FA, `IMP-REST-03` webhooks.
- Infra-dependent (needs deploy): `IMP-PLAT-02` Vercel Blob, `IMP-PLAT-03` observability.

## Partials already backend-done (UI/remainder pending) — quick to finish
- `IMP-RT-01` `meetings.getAttendanceReport` exists; no meeting-detail page (only `/meetings/[id]/call`)
  — needs a thin report render where meetings surface.
- `IMP-TRELLO-01` import-to-new-project + lead-gate backend done; needs a "create new project" UI toggle
  in `trello-import-content.tsx`.
- `IMP-PROJ-05` `updateBoard`/`updateLabel`/`deleteLabel`/`deleteFile` mutations exist; UI affordances
  (board rename, in-picker label edit/delete, file-delete button) pending.

## Key files created this engagement
- `src/lib/finance/currency.ts` (per-currency + FX helpers), `src/lib/rate-limit.ts`,
  `src/lib/api-json.ts` (`readJson`), `src/app/api/files/[name]/route.ts` (auth'd uploads → `private-uploads/`).
- Scripts: `scripts/enhancements.json`, `scripts/file-enhancements.ts`, `scripts/qa-move-cards.ts`,
  `scripts/lint-tool-schemas.ts` (+ pre-existing `scripts/qa-*` and maps).
- Pre-existing UNCOMMITTED prior-session WIP in the working tree (bun.lock, prisma/schema.prisma,
  package.json, several `src/lib/ai/tools/*.ts` untracked, etc.) was deliberately LEFT ALONE — not mine.
