# GitHub issue #226 is already fixed

Issue #226 reports that the staff password forms under **Organization → People** show only a
12-character minimum instead of the complete password policy. The current code already contains
the requested copy, so no application code needs to be changed.

## File-and-line evidence

- The **Add member** form states: “12–256 characters, with a lowercase letter, an uppercase letter
  and a digit.” (`src/app/(app)/organization/organization-admin-content.tsx:574-578`)
- The **Reset password** form states the same complete policy before explaining that existing
  sessions are revoked. (`src/app/(app)/organization/organization-admin-content.tsx:683-691`)
- The focused component test requires the complete policy to appear twice and verifies that both
  obsolete minimum-only messages are absent.
  (`src/app/(app)/organization/organization-admin-content.people.test.tsx:171-182`)
- Both staff operations enforce the shared letter-and-digit rules with a 12–256 character bound on
  the server. (`src/server/routers/organization-admin.ts:532-545`,
  `src/server/routers/organization-admin.ts:636-638`, `src/lib/password-policy.ts:21-26`)

The fix is present in commit `0c2cf233c877efe72833d9728bab263ce9695c60` (`fix(#226)`), which
predates this verification note.
