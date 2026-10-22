# Issue 446 archive recovery

Issue 446 asked whether the eight commits preserved at
`archive/fix/qa-b3-platform` still contained work worth restoring. The archived tag was not
available in this checkout, and the configured repository has no `origin`, so the commit summaries
from the issue were checked against the current tree rather than replayed wholesale.

## Restored

- **QA-233 — pg_trgm runtime permission.** Extension preparation revokes `PUBLIC EXECUTE`, while
  pharmacy catalogue search uses `public.similarity_op(text, text)`. The disposable RLS test had to
  grant that function explicitly, but runtime-role preparation and the documented manual setup did
  not. Runtime-role preparation now grants only that exact function to `devfathom_app`; it does not
  grant execution on every function or restore access to `PUBLIC`.

## Already present or skipped

- **QA-134 — seat-occupancy copy:** skipped because current workspace copy already says that active
  members occupy licensed seats, both in the People and access summary and beside the add-member
  form.
- **PR #282 follow-up and blocker note:** the valuable permission fix is restored above. The old
  typecheck-memory blocker note is historical and does not change the product, so it was not ported.
- **Merge commits:** skipped because replaying archive merge topology would also replay already
  integrated work. Only the missing leaf change was reproduced.
- **Removal of `BLOCKED.md`:** skipped because `BLOCKED.md` is absent from the current tree.
- **Codex task snapshot:** skipped because the summary does not identify an additional product fix,
  and restoring an opaque snapshot would violate the minimal-change requirement.

No migration is needed: `prepare-runtime-role.ts` is the existing idempotent owner-side provisioning
step for the application role and runs after the trusted extensions exist.
