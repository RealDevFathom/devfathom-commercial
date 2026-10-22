# GitHub issue #437: archived AI growth UI is already superseded

The three commits named in `archive/improve/ai-growth-ui` do not need to be
re-opened or cherry-picked. The current implementation already provides the
useful behavior, with narrower server-side authorization and a fail-closed
delivery boundary.

## Current-code evidence

- The growth entry point is gated on the Restaurant vertical, both required
  modules, financial-report permission, write permission for mutations, an
  active branch belonging to the current organization, and (for non-admin
  readers) an assignment to that branch
  (`src/lib/restaurant/growth-review.ts:56-85`).
- The inbox query re-runs that authorization inside the transaction, sets the
  branch RLS context, and filters by both `organizationId` and `branchId`
  (`src/lib/restaurant/growth-generation.ts:26-55`). Generation performs the
  write authorization and its additional catering permission check before it
  reads or writes growth data (`src/lib/restaurant/growth-generation.ts:59-74`).
- The current UI includes the useful archived inbox and detail behavior: it
  lists saved insights and links each one to its detail route
  (`src/components/restaurant/growth/growth-entries.tsx:45-60`), supports a
  date-bounded generation request (`src/components/restaurant/growth/growth-entries.tsx:61-112`),
  and renders evidence-backed recommendation details and review settings
  (`src/components/restaurant/growth/growth-review-panel.tsx:80-155`).
- Approval creates only an internal draft; the UI explicitly says that
  publishing and delivery are separate and that nothing was sent
  (`src/components/restaurant/growth/growth-review-panel.tsx:88-92`,
  `src/components/restaurant/growth/growth-review-panel.tsx:143-149`).
- The production WhatsApp factory retains the code-level live-send block even
  when the Meta provider is configured: both send methods always reject until
  owner approval (`src/lib/pharmacy/whatsapp/provider.ts:278-297`). A focused
  regression test covers the configured-provider case
  (`src/lib/pharmacy/whatsapp/provider.test.ts:198-206`).

## Archive disposition

| Archived commit | Decision | Reason |
| --- | --- | --- |
| `7b81f39e` — gated growth tick skeleton | Skip | Superseded by the stricter vertical, entitlement, permission, tenant, active-branch, and branch-assignment gates above. |
| `afc587fe` — campaign inbox, detail, and settings UI | Skip | Superseded by the saved-insight list, detail/review panel, evidence links, and persisted review settings above. Porting the older UI would create a second product surface. |
| `59d1f039` — drop unapproved sends and store the WhatsApp key encrypted | Skip | Unapproved live sends are already blocked in code and covered by a focused regression test. The current growth workflow does not persist a WhatsApp key at all, so importing archived key storage would add an unnecessary secret-bearing path. |

No archive code, migration, or new test is required. In particular, the live
WhatsApp send block must remain fail-closed.
