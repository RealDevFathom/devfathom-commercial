# RESUME — QA Remediation + Enhancement Program (DevFathom-Hub)

> Handoff for continuing after a context clear. Branch: **`fix/qa-remediation`**.
> Repo: **`WhatTheStack1/DevFathom-Hub`** (gh authed as WhatTheStack1).
> Read `/FIXES.md`, `/ENHANCEMENTS.md`, `/TICKETS.md`, `CLAUDE.md`, `AGENTS.md` first.

## Where it stands (UPDATED 2026-06-23 — user authorized "EVERYTHING" = tiers a+b+c)
- **Bugs: 53/53 DONE.** AUTH-01 (#27) UNBLOCKED & closed (commit `365ea6c`): session revocation via
  `User.tokenVersion`, validated on a local disposable Postgres. The bug program is complete.
- **Enhancements: 48 implemented / 2 partial / rest remaining** (milestone "Product Improvements" +
  internal "Improvements" board). Implemented this session: TRELLO-01, RT-01, RT-05, FIN-03, REST-01,
  PROJ-08, PROJ-09, IMP-AUTH-01 (password reset). Partial: IMP-AUTH-03 (sign-out-everywhere + revoke
  done; active-sessions list needs a session store), IMP-PROJ-05 (labels done+committed; board-rename +
  file-delete done IN-TREE but uncommitted — stuck in the project-detail-content.tsx redesign blob).
- **Build + `src/` typecheck GREEN** at every step. **Keystone NEVER modified** (`src/lib/abac/**`,
  `src/lib/authz.ts`). New bulk mutations + auth use the keystone's object-level guards (add-only).
- Session commits: `24787df 5ce253f d39fcbb 0ef4219 365ea6c b3e15c8 9b654ba` (+ reconciles).

## NON-NEGOTIABLE constraints (carry forward)
- **NO schema/mutating ops against the shared remote Neon DB** (`DATABASE_URL`). The ONLY allowed
  shared-DB write is **ticket status moves** on the internal board.
- **SCHEMA WORKFLOW IS NOW PROVEN (use it for every schema change):**
  - `postgresql@16` is brew-installed. Disposable cluster is up at `127.0.0.1:5433/devhub_local`
    (start via the scratchpad `pg-up.sh` pattern; GOTCHA: scratchpad path too long for a unix
    socket → set `unix_socket_directories='/tmp/pgdf'` and connect over TCP).
  - Edit `prisma/schema.prisma` → `bunx prisma generate` (no DB needed; keeps build/tsc green) →
    validate with `DATABASE_URL='postgresql://postgres@127.0.0.1:5433/devhub_local' bunx prisma db push --accept-data-loss`.
  - SAFE because `prisma.config.ts` does `import "dotenv/config"` (loads `.env`=Neon) but dotenv does
    NOT override an already-set env var — so the inline `DATABASE_URL` wins (verified). NEVER run a
    bare `prisma db push` (it would hit Neon). Deploy applies schema via `prisma db push` (no migrations dir).
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

## REMAINING WORK (user said do EVERYTHING — execute via the proven schema workflow + per-ticket commits)
- **Schema tier (b) still TODO** (each: edit schema → generate → local db push → implement → build/tsc → reconcile → commit):
  `IMP-PROJ-06` subtasks/deps (Task.parentId self-rel + TaskBlocker), `IMP-PROJ-07` WIP limits
  (Column.wipLimit), `IMP-CLI-05` contract↔project link (Contract.projectId), `IMP-FIN-04` partial
  payments (Payment model), `IMP-DASH-02` widget prefs (User.preferences Json), `IMP-AUTH-04`
  notification prefs (User.notificationPrefs Json), `IMP-RT-02` message edit-history (MessageEdit
  model), `IMP-HR-04` performance reviews (review models), `IMP-NOTE-02` note @mentions.
  Finish `IMP-AUTH-03` active-sessions list (needs a session-store rethink) + `IMP-PROJ-05` commit.
- **Big Bets (c) — all TODO:** `IMP-FIN-01` invoice edit+PDF+email, `IMP-PROJ-01` time tracking
  (TimeEntry model already exists — just wire CRUD+UI+rollup), `IMP-NOTE-01` note versioning,
  `IMP-HR-01` leave balances+calendar, `IMP-AUTH-02` 2FA (TOTP), `IMP-REST-03` webhooks.
- **Deferred/entangled:** `IMP-AI-02` citations half needs the assistant `src/lib/ai/context.ts` WIP
  (untracked) — either commit that WIP foundation first or do audit-viewer surfacing only.
  Infra (needs deploy): `IMP-PLAT-02` Vercel Blob, `IMP-PLAT-03` observability — implement code path + document.

## COMMIT-HYGIENE BLOCKER (important)
- `src/app/(app)/projects/[id]/project-detail-content.tsx` carries a HUGE (~1300-line) pre-existing
  projects-detail REDESIGN in the working tree (not part of this engagement). My PROJ-05 board-rename +
  file-delete edits are buried in it → NOT committed. `git add -p` is blocked in this env. Options for
  the next session: (1) commit that file wholesale with an honest "includes pre-existing redesign WIP"
  message to unblock the module, or (2) keep routing projects work through clean files (kanban-board.tsx,
  board/[boardId]/*, projects.ts). Other WIP files also left alone: many `src/lib/ai/tools/*`, `context.ts`,
  voice components, message-composer/item, assistant-panel, invoices-tab, projects-content, app-shell,
  prompt.ts, tools.ts, activity.ts, chat-helpers, bun.lock, package.json. Stage only each ticket's files.

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
