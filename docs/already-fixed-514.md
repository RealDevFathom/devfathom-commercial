# GitHub issue #514 is already fixed

Verified against the current code on 2026-10-22. The reported custom-role replacement failure was already fixed in commit `13e243273d46a064d5a879140b65318b7b828061`.

## Evidence

- `src/lib/organization-role-permissions.ts:3-23` defines the shared permission-array schema. It trims capability keys and rejects a capability that appears more than once, so conflicting `ALLOW` and `DENY` entries fail validation before any database mutation.
- `src/server/routers/organization-admin.ts:398-438` applies that schema to `organizationAdmin.upsertRole`, performs the role update and full permission replacement in one transaction, scopes reads and writes to the current organization, and locks an existing role row with `FOR UPDATE` before replacement.
- `src/lib/platform/commands.ts:2357-2397` applies the same schema and transaction/row-lock replacement pattern to the platform `organization.role` command.
- `src/lib/organization-role-permissions.test.ts:4-30` covers rejection of duplicate normalized capabilities and verifies that a unique `DENY` permission remains intact.
- `prisma/schema.prisma:10904-10916` retains the unique database constraint on `(organizationRoleId, capability)` as a final integrity guard.

Because validation occurs before entering either mutation and each replacement is atomic, invalid duplicate input cannot delete the existing permission set. The row lock serializes concurrent edits of an existing role. No additional code or migration is required.
