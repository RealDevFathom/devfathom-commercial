/**
 * Global `lower(email)` collision report — the evidence ADR-004 requires before
 * anyone designs a migration.
 *
 * ADR-003 D1 made identity uniqueness tenant-local: `email` is unique per
 * organization, so the same address may exist as N independent accounts in N
 * organizations. ADR-004 proposes reopening that decision with a global
 * `AuthenticationIdentity`. Whatever shape that takes, every account sharing a
 * normalized address has to collapse onto one identity row, and the population
 * that has to collapse is a fact about the data, not about the design.
 *
 * This script measures that population. It answers, per duplicate
 * `lower(btrim(email))` group:
 *
 *   - how many organizations the address spans;
 *   - how many accounts exist;
 *   - what account statuses they hold;
 *   - how many are SSO-managed or SCIM-managed;
 *   - how many have MFA enabled;
 *   - whether the group exceeds the ten-candidate discovery cap;
 *   - whether the group is demo/seed data or a real customer population.
 *
 * It is STRICTLY READ-ONLY. It opens one `READ ONLY` transaction, issues SELECT
 * statements only, and ends with ROLLBACK. It writes no rows, creates no
 * objects, and alters no schema. The only session state it touches is
 * transaction-local `set_config(..., true)`, which Postgres discards at
 * ROLLBACK.
 *
 * Cross-organization reads require the control-plane escape hatch: `users` is
 * FORCE ROW LEVEL SECURITY, so the report sets `app.is_platform_admin = 'true'`
 * transaction-locally — exactly what `withPlatformDb` does, and for exactly the
 * same reason. Run it as an operator, against a database you are allowed to
 * read whole.
 *
 *   DATABASE_URL='postgresql://...' bunx tsx scripts/report-global-email-collisions.ts
 *
 * Flags:
 *   --unmasked  print full addresses, organization slugs and account ids
 *               (default masks the local part and drops slugs)
 *   --reveal    alias for --unmasked
 *   --summary   totals and classification only, no per-group detail
 *   --json      emit JSON instead of text (honours --unmasked)
 *
 * The output is customer data. It is deliberately not written to a file, and it
 * must not be committed, pasted into an issue, or attached to a PR — not even
 * masked. Report counts, not rows.
 */
// `.env` only, and never overriding an inherited value — so an operator who
// exports DATABASE_URL for one specific database gets that database, and a
// developer with a local `.env` does not have to retype it.
import 'dotenv/config';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Client } = pg;

const APPLICATION_NAME = 'report-global-email-collisions';

/**
 * The discovery cap from ADR-003: shared-host login computes at most ten
 * candidates and audits anything beyond. A group larger than this cannot be
 * resolved by the existing login path and needs an explicit answer in the
 * migration design.
 */
const DISCOVERY_CANDIDATE_CAP = 10;

/**
 * Demo/seed classification is domain-based because there is no `isDemo` column
 * to consult. `company.com` is what `prisma/seed.ts` and `prisma/seed-demo.ts`
 * hand every foundation account; the rest are the RFC 2606 / RFC 6761 reserved
 * names the seeds use for tenant fixtures (`*.example.com`) and that no real
 * customer can own. Extend for a specific environment with
 * `DEMO_EMAIL_DOMAINS=one.test,two.internal`.
 */
const SEED_EMAIL_DOMAINS = [
  'company.com',
  'example.com',
  'example.org',
  'example.net',
  'example.edu',
  'example',
  'test',
  'invalid',
  'localhost',
  'local',
];

type Classification = 'demo' | 'mixed' | 'real';

type AccountRow = {
  normalized: string;
  accountId: string;
  organizationId: string;
  organizationSlug: string | null;
  organizationStatus: string | null;
  storedEmail: string;
  status: string;
  hasCredential: boolean;
  mfaEnabled: boolean;
  createdOn: string | null;
  orgHasActiveConnection: boolean;
  orgEnforcesSso: boolean;
  scimManaged: boolean;
};

type Group = {
  normalized: string;
  accounts: AccountRow[];
  organizationCount: number;
  accountCount: number;
  statusCounts: Record<string, number>;
  organizationStatusCounts: Record<string, number>;
  storedVariants: string[];
  credentialSet: number;
  credentialless: number;
  ssoManaged: number;
  scimManaged: number;
  inSsoEnforcedOrg: number;
  mfaEnabled: number;
  exceedsCap: boolean;
  classification: Classification;
};

export function parseArgs(argv: string[]) {
  const known = new Set(['--unmasked', '--reveal', '--summary', '--json']);
  for (const arg of argv) {
    if (!known.has(arg)) {
      console.error(`Unknown flag ${arg}. Supported: ${[...known].join(', ')}`);
      process.exit(2);
    }
  }
  return {
    // Addresses are masked unless the operator explicitly opts in.
    reveal: argv.includes('--unmasked') || argv.includes('--reveal'),
    summary: argv.includes('--summary'),
    json: argv.includes('--json'),
  };
}

function demoDomains(): string[] {
  const extra = (process.env.DEMO_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [...SEED_EMAIL_DOMAINS, ...extra];
}

function isSeedAddress(normalized: string, domains: string[]): boolean {
  const at = normalized.lastIndexOf('@');
  if (at < 0) return false;
  const domain = normalized.slice(at + 1);
  return domains.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
}

export function maskAddress(normalized: string): string {
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const head = local[0] ?? '';
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

export function maskId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function renderTally(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(
    ([a, countA], [b, countB]) => countB - countA || a.localeCompare(b)
  );
  return entries.length === 0 ? 'none' : entries.map(([key, count]) => `${key}=${count}`).join(' ');
}

/**
 * Statements this script is allowed to run outside the SELECT guard. Anything
 * that is not on this list and is not a SELECT/WITH throws before it reaches
 * the server.
 */
const CONTROL_STATEMENTS = new Set(['BEGIN TRANSACTION READ ONLY', 'ROLLBACK']);

const SELECT_ONLY = /^\s*(select|with)\b/i;

async function control(client: pg.Client, statement: string): Promise<void> {
  if (!CONTROL_STATEMENTS.has(statement)) {
    throw new Error(`Refusing to run an unrecognized control statement: ${statement}`);
  }
  await client.query(statement);
}

async function read<T extends pg.QueryResultRow>(
  client: pg.Client,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  if (!SELECT_ONLY.test(sql)) {
    throw new Error(`Refusing to run a statement that is not a SELECT: ${sql.slice(0, 60)}…`);
  }
  const { rows } = await client.query<T>(sql, params);
  return rows;
}

const IDENTITY_SQL = `
  SELECT current_database()                              AS "database",
         current_user                                    AS "role",
         current_setting('server_version')               AS "serverVersion",
         COALESCE(host(inet_server_addr()), 'unix socket') AS "serverAddress",
         COALESCE(inet_server_port(), 0)                 AS "serverPort",
         current_setting('transaction_read_only')        AS "transactionReadOnly"
`;

const TOTALS_SQL = `
  SELECT (SELECT count(*) FROM "users")                              AS "totalAccounts",
         (SELECT count(*) FROM "organizations")                      AS "totalOrganizations",
         (SELECT count(DISTINCT lower(btrim("email"))) FROM "users") AS "distinctAddresses"
`;

/**
 * One row per account that shares a normalized address with at least one other
 * account ANYWHERE in the database — the deliberate difference from
 * `report-email-collisions.ts`, which groups within an organization because it
 * serves a tenant-local unique index.
 */
const COLLISIONS_SQL = `
  WITH accounts AS (
    SELECT u."id"                               AS account_id,
           u."organizationId"                   AS organization_id,
           lower(btrim(u."email"))              AS normalized,
           u."email"                            AS stored_email,
           u."status"::text                     AS status,
           (u."password" IS NOT NULL)           AS has_credential,
           (u."twoFactorEnabledAt" IS NOT NULL) AS mfa_enabled,
           u."createdAt"                        AS created_at
      FROM "users" u
  ),
  colliding AS (
    SELECT normalized
      FROM accounts
     GROUP BY normalized
    HAVING count(*) > 1
  ),
  scim_managed AS (
    SELECT DISTINCT e."payload" ->> 'userId' AS account_id
      FROM "organization_scim_events" e
     WHERE e."resourceType" = 'User'
       AND jsonb_typeof(e."payload" -> 'userId') = 'string'
  ),
  org_identity AS (
    SELECT c."organizationId"                                    AS organization_id,
           bool_or(c."status" = 'ACTIVE')                        AS has_active_connection,
           bool_or(c."status" = 'ACTIVE' AND c."enforceSso")     AS enforces_sso
      FROM "organization_identity_connections" c
     GROUP BY c."organizationId"
  )
  SELECT a.normalized                             AS "normalized",
         a.account_id                             AS "accountId",
         a.organization_id                        AS "organizationId",
         o."slug"                                 AS "organizationSlug",
         o."status"::text                         AS "organizationStatus",
         a.stored_email                           AS "storedEmail",
         a.status                                 AS "status",
         a.has_credential                         AS "hasCredential",
         a.mfa_enabled                            AS "mfaEnabled",
         to_char(a.created_at, 'YYYY-MM-DD')      AS "createdOn",
         COALESCE(i.has_active_connection, false) AS "orgHasActiveConnection",
         COALESCE(i.enforces_sso, false)          AS "orgEnforcesSso",
         (s.account_id IS NOT NULL)               AS "scimManaged"
    FROM accounts a
    JOIN colliding c        ON c.normalized = a.normalized
    LEFT JOIN "organizations" o ON o."id" = a.organization_id
    LEFT JOIN org_identity i    ON i.organization_id = a.organization_id
    LEFT JOIN scim_managed s    ON s.account_id = a.account_id
   ORDER BY a.normalized, o."slug" NULLS LAST, a.created_at, a.account_id
`;

export function buildGroups(rows: AccountRow[], domains: string[]): Group[] {
  const byAddress = new Map<string, AccountRow[]>();
  for (const row of rows) {
    const bucket = byAddress.get(row.normalized);
    if (bucket) bucket.push(row);
    else byAddress.set(row.normalized, [row]);
  }

  return [...byAddress.entries()].map(([normalized, accounts]) => {
    const seed = isSeedAddress(normalized, domains);
    // Classification is per address today: every account in a group shares one
    // normalized address, so the domain verdict is the same for all of them.
    // `mixed` is kept because a future signal (per-organization seed marking)
    // can disagree across a group, and the caller should not have to change.
    const seedFlags = accounts.map(() => seed);
    const classification: Classification = seedFlags.every(Boolean)
      ? 'demo'
      : seedFlags.some(Boolean)
        ? 'mixed'
        : 'real';

    return {
      normalized,
      accounts,
      organizationCount: new Set(accounts.map((account) => account.organizationId)).size,
      accountCount: accounts.length,
      statusCounts: tally(accounts.map((account) => account.status)),
      organizationStatusCounts: tally(
        accounts.map((account) => account.organizationStatus ?? 'unknown')
      ),
      storedVariants: [...new Set(accounts.map((account) => account.storedEmail))],
      credentialSet: accounts.filter((account) => account.hasCredential).length,
      credentialless: accounts.filter((account) => !account.hasCredential).length,
      // SSO-managed: cannot use a password grant AND its organization has a
      // working IdP — a JIT- or SCIM-created account, not a lapsed one.
      ssoManaged: accounts.filter(
        (account) => !account.hasCredential && account.orgHasActiveConnection
      ).length,
      scimManaged: accounts.filter((account) => account.scimManaged).length,
      inSsoEnforcedOrg: accounts.filter((account) => account.orgEnforcesSso).length,
      mfaEnabled: accounts.filter((account) => account.mfaEnabled).length,
      exceedsCap: accounts.length > DISCOVERY_CANDIDATE_CAP,
      classification,
    };
  });
}

function sum(groups: Group[], pick: (group: Group) => number): number {
  return groups.reduce((total, group) => total + pick(group), 0);
}

function printText(
  identity: Record<string, unknown>,
  totals: Record<string, unknown>,
  groups: Group[],
  options: { reveal: boolean; summary: boolean }
) {
  const label = (group: Group) =>
    options.reveal ? group.normalized : maskAddress(group.normalized);

  console.log('Global lower(email) collision report');
  console.log(
    `database=${identity.database} role=${identity.role} ` +
      `server=${identity.serverAddress}:${identity.serverPort} ` +
      `version=${String(identity.serverVersion).split(' ')[0]} ` +
      `readOnlyTransaction=${identity.transactionReadOnly}`
  );
  console.log('');

  console.log(
    `accounts=${totals.totalAccounts} organizations=${totals.totalOrganizations} ` +
      `distinctNormalizedAddresses=${totals.distinctAddresses}`
  );

  if (groups.length === 0) {
    console.log('');
    console.log('No address is shared across accounts. A global identity table would');
    console.log('map one-to-one onto the existing rows, with no merge decisions to make.');
    return;
  }

  const demo = groups.filter((group) => group.classification === 'demo');
  const mixed = groups.filter((group) => group.classification === 'mixed');
  const real = groups.filter((group) => group.classification === 'real');
  const overCap = groups.filter((group) => group.exceedsCap);
  const crossOrg = groups.filter((group) => group.organizationCount > 1);

  console.log(
    `collisionGroups=${groups.length} accountsInCollisions=${sum(groups, (g) => g.accountCount)} ` +
      `crossOrganizationGroups=${crossOrg.length}`
  );
  console.log(
    `classification demo=${demo.length} mixed=${mixed.length} real=${real.length} ` +
      `(accounts demo=${sum(demo, (g) => g.accountCount)} mixed=${sum(mixed, (g) => g.accountCount)} real=${sum(real, (g) => g.accountCount)})`
  );
  console.log(
    `groupsExceeding${DISCOVERY_CANDIDATE_CAP}=${overCap.length} ` +
      `(accounts=${sum(overCap, (g) => g.accountCount)}, largestGroup=${Math.max(
        ...groups.map((group) => group.accountCount)
      )}, mostOrganizations=${Math.max(...groups.map((group) => group.organizationCount))})`
  );
  console.log(
    `accountsWithCredential=${sum(groups, (g) => g.credentialSet)} ` +
      `credentialless=${sum(groups, (g) => g.credentialless)} ` +
      `ssoManaged=${sum(groups, (g) => g.ssoManaged)} ` +
      `scimManaged=${sum(groups, (g) => g.scimManaged)} ` +
      `inSsoEnforcedOrganization=${sum(groups, (g) => g.inSsoEnforcedOrg)} ` +
      `mfaEnabled=${sum(groups, (g) => g.mfaEnabled)}`
  );
  console.log(
    `accountStatuses ${renderTally(tally(groups.flatMap((g) => Object.entries(g.statusCounts).flatMap(([status, count]) => Array(count).fill(status) as string[]))))}`
  );

  if (options.summary) return;

  console.log('');
  console.log(
    options.reveal
      ? 'Per-group detail (revealed — do not paste this anywhere).'
      : 'Per-group detail (masked — pass --unmasked to an operator session that needs the addresses).'
  );
  console.log('');

  const ordered = [...groups].sort(
    (a, b) =>
      b.accountCount - a.accountCount ||
      b.organizationCount - a.organizationCount ||
      a.normalized.localeCompare(b.normalized)
  );

  for (const group of ordered) {
    console.log(
      `${label(group)} — organizations=${group.organizationCount} accounts=${group.accountCount} ` +
        `classification=${group.classification}${group.exceedsCap ? ' EXCEEDS-CAP' : ''}`
    );
    console.log(`    accountStatuses: ${renderTally(group.statusCounts)}`);
    console.log(`    organizationStatuses: ${renderTally(group.organizationStatusCounts)}`);
    console.log(
      `    credentialSet=${group.credentialSet} credentialless=${group.credentialless} ` +
        `ssoManaged=${group.ssoManaged} scimManaged=${group.scimManaged} ` +
        `inSsoEnforcedOrganization=${group.inSsoEnforcedOrg} mfaEnabled=${group.mfaEnabled}`
    );
    console.log(`    storedCasingVariants=${group.storedVariants.length}`);
    for (const account of group.accounts) {
      const organization = options.reveal
        ? `${account.organizationId}${account.organizationSlug ? ` (${account.organizationSlug})` : ''}`
        : maskId(account.organizationId);
      console.log(
        `      - organization=${organization} account=${
          options.reveal ? account.accountId : maskId(account.accountId)
        } status=${account.status} credential=${account.hasCredential ? 'set' : 'none'} ` +
          `mfa=${account.mfaEnabled ? 'on' : 'off'} scim=${account.scimManaged ? 'yes' : 'no'} ` +
          `orgSso=${account.orgHasActiveConnection ? 'active' : 'none'}` +
          `${account.orgEnforcesSso ? ' orgSsoEnforced' : ''} created=${account.createdOn ?? 'unknown'}`
      );
    }
    console.log('');
  }
}

function printJson(
  identity: Record<string, unknown>,
  totals: Record<string, unknown>,
  groups: Group[],
  options: { reveal: boolean }
) {
  const payload = {
    database: {
      name: identity.database,
      role: identity.role,
      server: `${identity.serverAddress}:${identity.serverPort}`,
      version: identity.serverVersion,
      readOnlyTransaction: identity.transactionReadOnly,
    },
    totals: {
      accounts: Number(totals.totalAccounts),
      organizations: Number(totals.totalOrganizations),
      distinctNormalizedAddresses: Number(totals.distinctAddresses),
      collisionGroups: groups.length,
      accountsInCollisions: sum(groups, (group) => group.accountCount),
      crossOrganizationGroups: groups.filter((group) => group.organizationCount > 1).length,
      groupsExceedingCap: groups.filter((group) => group.exceedsCap).length,
      discoveryCandidateCap: DISCOVERY_CANDIDATE_CAP,
      accountsWithCredential: sum(groups, (group) => group.credentialSet),
      credentialless: sum(groups, (group) => group.credentialless),
      ssoManaged: sum(groups, (group) => group.ssoManaged),
      scimManaged: sum(groups, (group) => group.scimManaged),
      inSsoEnforcedOrganization: sum(groups, (group) => group.inSsoEnforcedOrg),
      mfaEnabled: sum(groups, (group) => group.mfaEnabled),
    },
    classification: {
      demo: groups.filter((group) => group.classification === 'demo').length,
      mixed: groups.filter((group) => group.classification === 'mixed').length,
      real: groups.filter((group) => group.classification === 'real').length,
    },
    groups: groups.map((group) => ({
      address: options.reveal ? group.normalized : maskAddress(group.normalized),
      organizationCount: group.organizationCount,
      accountCount: group.accountCount,
      exceedsCap: group.exceedsCap,
      classification: group.classification,
      accountStatuses: group.statusCounts,
      organizationStatuses: group.organizationStatusCounts,
      storedCasingVariants: group.storedVariants.length,
      credentialSet: group.credentialSet,
      credentialless: group.credentialless,
      ssoManaged: group.ssoManaged,
      scimManaged: group.scimManaged,
      inSsoEnforcedOrganization: group.inSsoEnforcedOrg,
      mfaEnabled: group.mfaEnabled,
      accounts: group.accounts.map((account) => ({
        organizationId: options.reveal ? account.organizationId : maskId(account.organizationId),
        organizationSlug: options.reveal ? account.organizationSlug : null,
        accountId: options.reveal ? account.accountId : maskId(account.accountId),
        status: account.status,
        hasCredential: account.hasCredential,
        mfaEnabled: account.mfaEnabled,
        scimManaged: account.scimManaged,
        organizationHasActiveSso: account.orgHasActiveConnection,
        organizationEnforcesSso: account.orgEnforcesSso,
        createdOn: account.createdOn,
      })),
    })),
  };
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl, application_name: APPLICATION_NAME });
  await client.connect();

  try {
    await control(client, 'BEGIN TRANSACTION READ ONLY');

    // Transaction-local only: `set_config(..., true)` is discarded at ROLLBACK.
    // `users` and `organizations` are FORCE ROW LEVEL SECURITY, so without this
    // the report would silently return zero rows rather than fail.
    await read(client, `SELECT set_config('app.is_platform_admin', 'true', true)`);
    await read(client, `SELECT set_config('statement_timeout', '120s', true)`);

    const [identity] = await read<Record<string, unknown>>(client, IDENTITY_SQL);
    const [totals] = await read<Record<string, unknown>>(client, TOTALS_SQL);
    const rows = await read<AccountRow>(client, COLLISIONS_SQL);

    if (!identity || !totals) throw new Error('The database returned no identity or totals row.');

    const groups = buildGroups(rows, demoDomains());

    if (options.json) printJson(identity, totals, groups, options);
    else printText(identity, totals, groups, options);
  } finally {
    // Nothing to commit — this transaction only ever read.
    await control(client, 'ROLLBACK');
    await client.end();
  }
}

/**
 * Run only when executed directly (not when imported by tests). Both sides are
 * resolved through `realpathSync` so a symlinked or wrapper-rewritten
 * `argv[1]` still matches instead of silently exiting 0 with no output.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(self) === realpathSync(resolve(invoked));
  } catch {
    return self === resolve(invoked);
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
