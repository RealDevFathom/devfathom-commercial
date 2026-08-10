# SCIM credential rotation after the audit redactor leak (issue #10)

**Status:** operational runbook. A human executes it. Nothing in this repository
executes any step here, and the code change in this branch rotates nothing.

## Why

Until this branch, `organization.scim.token` wrote its result — including the
plaintext bearer token — into `platform_audit_logs.after`. Any SCIM credential
issued while that code was deployed must be treated as disclosed at rest: the
audit table is retained, exported, and backed up on the assumption that it is
safe to keep.

A disclosed SCIM token grants create / update / deactivate on that
organization's users (`/api/scim/v2/Users`, `/api/scim/v2/Groups`). A token
issued with "No expiry" never expires on its own — `src/lib/scim.ts` only
enforces `expiresAt` when it is set — so time does not close this for you.

## Before you start

1. Run the inventory against the deployment you are rotating. It is read-only
   and prints no credential material:

   ```
   INVENTORY_DATABASE_URL=postgresql://... \
     bunx tsx --tsconfig scripts/tsconfig.json scripts/audit-secret-inventory.ts
   ```

2. Keep its output local. The organization identifiers it prints must not be
   pasted into an issue, a pull request, a commit message, or a chat channel.

3. If it reports **0** audit rows with a credential-shaped key and **0** active
   SCIM credentials, stop: there is nothing to rotate. Record that result.

## Who

| Role                                      | Does                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| Platform operator (`organizations:write`) | Issues and revokes credentials in the console                                       |
| Tenant IdP administrator                  | Installs the new bearer token in Okta / Entra / the tenant's provisioning connector |
| Incident owner                            | Sequences the tenants, confirms completion, closes the record                       |

The platform operator cannot finish alone: a revoked token stops that tenant's
provisioning until its administrator installs the replacement. Contact each
tenant administrator **before** revoking anything.

## Order

Do this per organization, one at a time, oldest credential first. Never revoke
before the replacement is installed and proven.

1. **Issue** a new credential for the organization (`/platform/organizations/<id>`,
   SCIM section). Set an expiry — do not choose "No expiry". The token is shown
   once, at creation; it is no longer written to the audit ledger.
2. **Hand off** the new token to the tenant IdP administrator over your normal
   secret-sharing channel. Not email, not a ticket comment.
3. **Install and verify.** The administrator swaps the token in the provisioning
   connector and runs one provisioning test. Confirm the SCIM events feed for
   that organization shows a successful operation against the new credential.
4. **Revoke** the old credential in the console. Revocation is immediate:
   `src/lib/scim.ts` rejects a revoked token on the next request.
5. **Confirm** by re-running the inventory: the old credential id is gone from
   the active list.

## What breaks during the window

- Between step 4 and a working step 3, that tenant's SCIM provisioning fails
  with `401`. Joiner/leaver automation stops; existing sessions and logins are
  unaffected — SCIM only provisions accounts.
- Nothing else on the platform is affected. Rotation is per organization, so a
  tenant that has not been reached yet keeps working on its old credential.
- Plan each tenant's window outside its HR sync schedule if it runs one.

## The audit rows themselves

The leaked rows stay where they are. Do not delete or rewrite them: this is the
tamper-evident ledger, and editing it to hide an incident is worse than the
incident. Once every credential named by the inventory is revoked, the recorded
token strings are inert. If your retention policy requires purging them anyway,
that is a separate, reviewed change with its own record — not part of this
rotation.

## Damaged platform settings

The same defect wrote `{ "encrypted": "[REDACTED]" }` over sensitive settings.
Those values are **not recoverable** — the ciphertext was destroyed before it
reached the database, and no copy exists. For each key the inventory lists under
"sensitive settings that do not decrypt", the owner of that integration must
re-enter the secret through **Platform settings → Configuration registry**, which
now stores real ciphertext. Verify by confirming the setting no longer appears
in the inventory output.

## Completion

The rotation is complete when, for the target deployment:

- the inventory reports every previously-listed credential id as no longer
  active, and
- the inventory reports 0 sensitive settings that do not decrypt, and
- each tenant administrator has confirmed one successful provisioning run on the
  new credential.

Record the date, the operator, and the tenant count in your incident log. Do not
record credential ids or organization ids there unless that log is itself
access-controlled.
