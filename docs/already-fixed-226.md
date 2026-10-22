# GitHub issue #226 is already fixed

Issue #226 reports that the staff password forms under **Organization → People** show only a
12-character minimum instead of the complete password policy. The current code contains the
requested copy. As follow-up defense in depth, both fields also expose the server's 12–256 length
bounds to native client-side validation.

## File-and-line evidence

- The **Add member** form states: “12–256 characters, with a lowercase letter, an uppercase letter
  and a digit,” and bounds the input to 12–256 characters.
  (`src/app/(app)/organization/organization-admin-content.tsx:568-578`)
- The **Reset password** form states the same complete policy before explaining that existing
  sessions are revoked, with the same input bounds.
  (`src/app/(app)/organization/organization-admin-content.tsx:683-696`)
- The focused component test requires the complete policy to appear twice and verifies that both
  obsolete minimum-only messages are absent. It also checks the minimum and maximum input lengths.
  (`src/app/(app)/organization/organization-admin-content.people.test.tsx:171-187`)
- Both staff operations enforce the shared letter-and-digit rules with a 12–256 character bound on
  the server. (`src/server/routers/organization-admin.ts:532-545`,
  `src/server/routers/organization-admin.ts:636-638`, `src/lib/password-policy.ts:21-26`)

The fix is present in commit `0c2cf233c877efe72833d9728bab263ce9695c60` (`fix(#226)`), which
predates this verification note.
