/**
 * Read-only inventory for issue #10.
 *
 * Answers one question: which rows were damaged by the key-name redactor
 * before it was replaced — audit rows that captured a plaintext credential,
 * and sensitive settings whose ciphertext was overwritten with '[REDACTED]'.
 *
 * It reads. It never writes, never rotates, never deletes. The connection is
 * opened with `default_transaction_read_only=on`, so the server rejects a
 * write even if this file is edited later; every statement below is a SELECT.
 * (A connection pooler may refuse startup options — connect directly if so.)
 *
 * It prints identifiers, counts and timestamps only: never a token, never
 * ciphertext, never a password or connection string, and never a fragment,
 * length or hash of one. Organization identifiers appear here so an operator
 * can act on them; keep them in this terminal — they do not belong in an
 * issue, a pull request, a commit message, or a committed file.
 *
 *   INVENTORY_DATABASE_URL=postgresql://... \
 *     bunx tsx --tsconfig scripts/tsconfig.json scripts/audit-secret-inventory.ts
 *
 * DATABASE_URL is deliberately not consulted: naming the target is the point.
 *
 * `before` is not scanned. It only ever held rows read back from the database,
 * which store `tokenHash`, never the bearer token itself; the plaintext could
 * only reach `after`, via the issuing command's result.
 */
import pg from 'pg';

import { decryptSecret, encryptionConfigured } from '@/lib/secret-crypto';

const { Client } = pg;

const databaseUrl = process.env.INVENTORY_DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'INVENTORY_DATABASE_URL is required. This script never falls back to DATABASE_URL:\n' +
      'name the database you mean to inventory.'
  );
  process.exit(2);
}

/** Key names that would carry a bearer credential in an audit payload. */
const CREDENTIAL_KEY =
  '^(token|secret|password|passphrase|credential|api_?key|client_?secret|private_?key|access_?token|refresh_?token)$';

type LeakedAuditRow = {
  id: string;
  createdAt: Date;
  organizationId: string | null;
  action: string;
};
type ScimCredentialRow = {
  id: string;
  organizationId: string;
  createdAt: Date;
  neverExpires: boolean;
};
type SensitiveSetting = { key: string; value: unknown };

/** Why a stored sensitive setting could not be read back. Never the value. */
function settingFailure(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'not an encrypted envelope';
  }
  const envelope = (value as Record<string, unknown>).encrypted;
  if (typeof envelope !== 'string') return 'not an encrypted envelope';
  if (envelope === '[REDACTED]') return 'ciphertext replaced by the redactor';
  if (!encryptionConfigured()) return 'undetermined: PLATFORM_ENCRYPTION_KEY is not set here';
  try {
    decryptSecret(envelope);
    return null;
  } catch {
    return 'decryption failed';
  }
}

async function main() {
  const client = new Client({
    connectionString: databaseUrl,
    options: '-c default_transaction_read_only=on',
  });
  await client.connect();

  try {
    const leaked = await client.query<LeakedAuditRow>(
      `SELECT log.id, log."createdAt", log."organizationId", log.action
         FROM platform_audit_logs log
        WHERE EXISTS (
                SELECT 1
                  FROM (SELECT node
                          FROM jsonb_path_query(log.after, '$.**') AS node
                         WHERE jsonb_typeof(node) = 'object') AS objects,
                       LATERAL jsonb_object_keys(objects.node) AS key
                 WHERE key ~* $1)
        ORDER BY log."createdAt"`,
      [CREDENTIAL_KEY]
    );

    const credentials = await client.query<ScimCredentialRow>(
      `SELECT id, "organizationId", "createdAt", ("expiresAt" IS NULL) AS "neverExpires"
         FROM organization_scim_tokens
        WHERE "revokedAt" IS NULL
          AND ("expiresAt" IS NULL OR "expiresAt" > now())
        ORDER BY "createdAt"`
    );

    const settings = await client.query<SensitiveSetting>(
      `SELECT key, value FROM platform_settings WHERE sensitive = true ORDER BY key`
    );
    const damaged = settings.rows
      .map((row) => ({ key: row.key, failure: settingFailure(row.value) }))
      .filter((row): row is { key: string; failure: string } => row.failure !== null);

    const organizations = [
      ...new Set(leaked.rows.map((row) => row.organizationId).filter((value) => value !== null)),
    ];

    console.log('# Audit secret inventory (issue #10) — read only\n');

    console.log(`audit rows whose "after" contains a credential-shaped key: ${leaked.rowCount}`);
    for (const row of leaked.rows) {
      console.log(
        `  ${row.id}  ${row.createdAt.toISOString()}  ${row.action}  org=${row.organizationId ?? '—'}`
      );
    }

    console.log(`\norganizations named by those rows: ${organizations.length}`);
    for (const organizationId of organizations) console.log(`  ${organizationId}`);

    console.log(`\nactive SCIM credentials: ${credentials.rowCount}`);
    for (const row of credentials.rows) {
      console.log(
        `  ${row.id}  ${row.createdAt.toISOString()}  org=${row.organizationId}` +
          `${row.neverExpires ? '  no-expiry' : ''}`
      );
    }

    console.log(`\nsensitive settings that do not decrypt: ${damaged.length}`);
    for (const row of damaged) console.log(`  ${row.key}  (${row.failure})`);

    console.log(
      `\nrotate: ${leaked.rowCount ? 'yes — see docs/security/scim-token-rotation.md' : 'no leaked audit rows found'}`
    );
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Inventory failed.');
  process.exitCode = 1;
});
