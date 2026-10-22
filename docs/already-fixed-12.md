# GitHub issue #12 — already fixed

Verified against the current branch on 2026-10-22. No production or test code was changed because
the reported password-reset vulnerability is already covered by the current implementation.

## Evidence

- **A distinct privileged capability protects the command.**
  `organization.user.password` is classified as sensitive and `capabilityFor` maps every sensitive
  command to `organizations:security:write` (`src/lib/platform/commands.ts:229-249`). Only
  `SUPER_ADMIN` has that capability (and the wildcard); `OPERATIONS` retains ordinary
  `organizations:write` but not the security capability (`src/lib/platform/capabilities.ts:3-14`).
  The command dispatcher checks the resolved capability before opening the mutation transaction
  (`src/lib/platform/commands.ts:3886-3903`).

- **A meaningful reason is mandatory and audited.**
  Sensitive-command reasons are trimmed and constrained to 10–500 characters
  (`src/lib/platform/commands.ts:242`). The dispatcher validates the reason before running the
  command and adds it to the command's audit projection (`src/lib/platform/commands.ts:3903-3920`).
  The shared form independently supplies a required reason textarea with a minimum length of 10 for
  `organization.user.password` (`src/components/platform/platform-command-form.tsx:198-222`).

- **The UI requires an explicit, contextual confirmation.**
  The password-reset form's confirmation names the target user and organization and states that
  existing sessions end and a new password is required at next sign-in
  (`src/app/platform/(console)/organizations/[id]/page.tsx:1052-1067`).

- **An operator-selected value is only a temporary credential.**
  Resetting a password increments `tokenVersion` to revoke existing sessions and sets
  `mustChangePassword`, forcing replacement of the temporary password
  (`src/lib/platform/commands.ts:2513-2525`). The schema documents and persists that force-change
  state (`prisma/schema.prisma:2786-2793`).

- **The affected user is notified without disclosing the temporary credential.**
  The command creates an in-product notification and an email outbox effect for the target user;
  neither message includes the password (`src/lib/platform/commands.ts:2527-2554`). The reset result
  and audit projection contain only the target ID and reset/force-change flags
  (`src/lib/platform/commands.ts:2555-2560`).

- **Focused regressions already cover the finding.**
  The command tests assert that `OPERATIONS` and every other non-super-admin role receive 403 before
  mutation, that absent/blank/short reasons reject before writes, and that a successful reset
  records the reason while excluding the password (`tests/platform-sensitive-commands.test.ts:53-109`).
  Form tests assert required reason validation/submission and the contextual confirmation
  (`tests/platform-sensitive-forms.test.tsx:9-45`,
  `tests/platform-sensitive-forms.test.tsx:87-91`).

## Conclusion

All acceptance criteria are represented in the current code: elevated authorization, mandatory
operator intent, explicit confirmation, forced credential replacement, out-of-band notification,
and focused authorization/validation regressions. The audited support-access flow remains
unchanged and is still the non-credential route for ordinary support work.
