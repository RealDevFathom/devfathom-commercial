# RESUME — QA Remediation + Enhancement Program (DevFathom-Hub)

> Handoff for continuing after a context clear. Branch: **`fix/qa-remediation`**.
> Repo: **`WhatTheStack1/DevFathom-Hub`** (gh authed as WhatTheStack1).
> Read `/FIXES.md`, `/ENHANCEMENTS.md`, `/TICKETS.md`, `CLAUDE.md`, `AGENTS.md` first.

## Where it stands (UPDATED 2026-06-23 — user authorized "EVERYTHING" = tiers a+b+c)
- **Bugs: 53/53 DONE.** AUTH-01 (#27) UNBLOCKED & closed (commit `365ea6c`): session revocation via
  `User.tokenVersion`, validated on a local disposable Postgres. The bug program is complete.
- **Enhancements: 58 implemented / 3 partial / 4 todo / 5 Big Bets.** Implemented across the two
  "everything" sessions: TRELLO-01, RT-01/02/05, FIN-03/04, REST-01, PROJ-01/06/08/09, IMP-AUTH-01,
  CLI-04/05, AUTH-04, DASH-02, NOTE-02, HR-04. Schema (validated on local PG, db-push-deployed):
  User.tokenVersion/passwordChangedAt/preferences/notificationPrefs, PasswordResetToken, Column.wipLimit,
  Contract.projectId, Task.parentId + TaskBlocker, Payment, MessageEdit, ReviewCycle+Review, NoteMention.
  Partial: IMP-AUTH-03 (sign-out-everywhere + revoke done; active-sessions list needs a session store),
  IMP-PROJ-05 (labels committed; board-rename + file-delete done IN-TREE, stuck in the
  project-detail-content.tsx redesign blob), IMP-PROJ-07 (WIP limits done; board templates pending).
  **REMAINING — 5 Big Bets** (each warrants focused context; some need schema + the proven local-PG loop):
  FIN-01 invoice edit+PDF+email (touches the WIP invoices-tab.tsx; FIN-04 worked around it with a
  separate panel — same trick or accept the WIP), PROJ-01-style done; NOTE-01 note versioning (add
  NoteRevision model), HR-01 leave balances+calendar (add accrual/balance model), AUTH-02 2FA (User
  TOTP fields + recovery-code model — security-critical, review carefully), REST-03 webhooks (Webhook/
  Subscription/Delivery models + signed outbound events from finance/projects emit points).
  **4 todo:** TRELLO-02 (map cover/customfields/dueComplete — likely needs Task cols), AI-02 (citations —
  entangled w/ the untracked assistant src/lib/ai/context.ts WIP; decide whether to commit that foundation
  or do audit-viewer surfacing only), PLAT-02 Vercel Blob + PLAT-03 observability (need a deploy — deliver
  code path + doc). **RECONCILE GOTCHA (fixed):** file-enhancements.ts task.update now uses select:{id}
  so client-vs-Neon column drift (P2022) can't break the board sync; keep any new shared-DB script ops
  scoped to columns that exist on Neon (the generated client is ahead of Neon until each migration deploys).
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

## ✅ NEAR-COMPLETE (2026-06-24): 65/70 implemented · 3 partial · 2 todo · 0 planned. Bugs 53/53. All 6 Big Bets shipped.
The ONLY remaining items are externally gated, not "unstarted work":
- **PLAT-02 (Vercel Blob), PLAT-03 (observability)** — need a real deploy + external service
  (Blob token / error-tracking DSN) + a dependency; can't be built/validated in this env. Deploy-gated.
- **PROJ-05 (board-rename + file-delete), PROJ-07 (board templates)** — the code/affordances belong in
  `project-detail-content.tsx`, which holds the user's large uncommitted REDESIGN blob. PROJ-05's
  rename+file-delete are already written IN-TREE there; committing requires committing that blob. BLOCKED on
  the user's decision to commit their redesign WIP. (PROJ-05 labels + PROJ-07 WIP-limits already shipped.)
- **AI-02 citations half** — needs the untracked assistant `src/lib/ai/context.ts` WIP committed first
  (audit-surfacing half already shipped → AI-02 is partial).
If the user authorizes committing their WIP: commit the redesign blob → finish PROJ-05 (add file-delete/
rename are already there; just stage) + PROJ-07 templates; commit the assistant WIP → add AI-02 citations.

## (historical) REMAINING WORK — mostly DONE now; kept for context
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
