# GitHub issue #417: already fixed

Issue #417 reported that `POST /api/v1/projects` accepted `clientId` and
`memberIds` without verifying that the referenced records belonged to the API
token's organization. The current code already addresses that report, so no
runtime code was changed during this review.

## File-and-line evidence

- `src/app/api/v1/projects/route.ts:51-56` builds the complete, deduplicated
  member list (including the caller) and validates both that list and the
  optional client with `ctx.organizationId` before project creation.
- `src/app/api/v1/projects/route.ts:57-62` converts an organization-reference
  `BAD_REQUEST` into an HTTP 400 response and rethrows unexpected errors.
- `src/app/api/v1/projects/route.ts:64-84` performs `project.create` only after
  both ownership checks have completed successfully.
- `src/server/org-refs.ts:21-42` implements `assertInOrganization` with an
  explicit `organizationId` predicate and rejects the request unless every
  distinct supplied ID is returned.
- `src/app/api/v1/projects/route.test.ts:45-64` verifies that member and client
  ownership checks use the token organization and run before the write.
- `src/app/api/v1/projects/route.test.ts:66-87` verifies that either a foreign
  member or a foreign client produces HTTP 400 and that `project.create` is not
  called.

These checks preserve tenant isolation independently of PostgreSQL foreign-key
behavior and satisfy the issue's expected outcome: a foreign reference is
rejected with a 400 response and nothing is written.
