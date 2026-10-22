# Issue #54: already fixed in code

Issue #54 is an operational follow-up to issue #10, not a request for another
code path. The current tree already contains the merged code fix, its focused
regression coverage, the read-only inventory, and the human-run remediation
runbook. No production inventory or credential rotation was attempted here.

## Current-code evidence

- The platform-command contract separates the persisted, one-time reveal, and
  audit representations, and explicitly documents the issue #10 failure mode
  (`src/lib/platform/commands.ts:138-178`). The audit writer consumes only the
  declared audit projection and returns the reveal value separately
  (`src/lib/platform/commands.ts:3872-3897`).
- SCIM issuance stores only a SHA-256 token hash, returns the bearer token through
  the one-time reveal representation, and sends only the credential's non-secret
  identity to the audit representation (`src/lib/platform/commands.ts:2298-2327`).
- Sensitive-setting writes pass the encrypted envelope directly to persistence;
  they do not pass stored ciphertext through an audit redactor
  (`src/lib/platform/commands.ts:3793-3835`).
- Focused database regression tests prove that the plaintext SCIM token is absent
  from the audit row and all readable storage, while sensitive settings persist
  the exact generated ciphertext and decrypt back to their original value
  (`src/lib/platform/audit-secret-redaction.test.ts:152-239`). The same suite
  verifies that an undeclared audit projection fails closed rather than falling
  back to the reveal payload
  (`src/lib/platform/audit-secret-redaction.test.ts:270-321`).
- The inventory requires its own explicit connection variable, enables
  `default_transaction_read_only=on`, and uses only `SELECT` statements
  (`scripts/audit-secret-inventory.ts:8-22`,
  `scripts/audit-secret-inventory.ts:78-110`). It intentionally emits local
  operational identifiers, with an explicit warning that they must not enter an
  issue, pull request, commit message, or committed file
  (`scripts/audit-secret-inventory.ts:13-17`).
- The existing runbook requires human coordination, replacement installation and
  verification before revocation, expiring replacement credentials, re-entry of
  unrecoverable settings, a final clean inventory, and an aggregate incident
  record (`docs/security/scim-token-rotation.md:19-63`,
  `docs/security/scim-token-rotation.md:83-105`). It also explicitly states that
  repository code performs none of these operational steps
  (`docs/security/scim-token-rotation.md:1-4`).

## Disposition

There is no additional code fix to port. Completing issue #54 requires a human
operator to execute the existing runbook independently in every live deployment
and record only the permitted aggregate evidence in the issue. The repository
cannot truthfully claim completion of those live operational steps, and
automating them would contradict the issue's constraints.
