import 'server-only';

import { discoverOidc } from '@/lib/oidc-discovery';
import { deleteSpentSsoStates, SSO_CLEANUP_BATCH_SIZE } from '@/lib/sso-state';

import { resolveTxt } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import {
  Prisma,
  type PlatformJob,
  type PlatformJobType,
  type PrismaClient,
} from '@/generated/prisma/client';
import { claimJob, runClaimedJob, type JobResult } from './job-runner';
import { endSupportSessions } from '@/lib/platform/capabilities';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { vercelProvisioningConfiguration } from '@/lib/platform/provisioning-config';
import { CAMERA_EVIDENCE_CAPTURE_WINDOW_MS, cameraEvidenceDueSql } from '@/lib/cameras/evidence';
import {
  PHARMACY_CAMERA_SNAPSHOT_JOB,
  runCameraEvidenceRetentionJob,
  runCounterEvidenceSnapshotJob,
} from '@/lib/pharmacy/counter-evidence';
import {
  OwnerDataExportTimeLimitError,
  OwnerDataExportTooLargeError,
  purgeExpiredOwnerDataExports,
  runPharmacyOwnerDataExportJob,
} from '@/lib/pharmacy/owner-data-export';
import {
  archiveWhatsAppConsentBeforeTenantPurge,
  deleteExpiredWhatsAppConsentArchives,
} from '@/lib/pharmacy/whatsapp/consent-archive';
import {
  previousRetentionPurgeResume,
  purgeExpiredPharmacyRecords,
} from '@/lib/pharmacy/retention-purge';

type JobPayload = Record<string, unknown>;

const STALE_JOB_MS = 15 * 60_000;

/** A failure that no retry can cure: the job is marked FAILED at once. */
class PermanentJobError extends Error {}
const CONTROL_PLANE_TABLES = new Set([
  'organizations',
  'organization_lifecycle_events',
  'organization_deployments',
  'organization_modules',
  'organization_limits',
  'organization_usage_counters',
  'organization_brands',
  'platform_jobs',
  'platform_audit_logs',
  'platform_support_sessions',
  'platform_contracts',
  'platform_contract_modules',
  'platform_invoices',
  'platform_payments',
  'platform_renewal_records',
]);

function objectPayload(value: Prisma.JsonValue | null): JobPayload {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JobPayload) : {};
}

function requiredOrganization(job: PlatformJob): string {
  if (!job.organizationId) throw new Error(`${job.type} requires an organization.`);
  return job.organizationId;
}

function requiredString(payload: JobPayload, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Job payload requires "${key}".`);
  }
  return value.trim();
}

async function recoverStaleJobs(): Promise<number> {
  return withPlatformDb(async (db) => {
    const result = await db.platformJob.updateMany({
      where: {
        status: 'RUNNING',
        startedAt: { lt: new Date(Date.now() - STALE_JOB_MS) },
      },
      data: {
        status: 'QUEUED',
        scheduledAt: new Date(),
        error: 'Recovered after the previous worker lease expired.',
        startedAt: null,
      },
    });
    return result.count;
  });
}

async function sharedProvision(
  db: PrismaClient,
  job: PlatformJob,
  payload: JobPayload
): Promise<JobResult> {
  const organizationId = requiredOrganization(job);
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { slug: true },
  });
  if (!organization) throw new Error('Organization no longer exists.');
  const baseDomain = (process.env.PLATFORM_BASE_DOMAIN ?? 'localhost').replace(/^admin\./, '');
  const protocol = baseDomain === 'localhost' ? 'http' : 'https';
  const url =
    typeof payload.url === 'string' && payload.url
      ? payload.url
      : `${protocol}://${organization.slug}.${baseDomain}`;
  const deployment = await db.organizationDeployment.upsert({
    where: { organizationId_environment: { organizationId, environment: 'production' } },
    update: {
      mode: 'SHARED',
      provider: 'VERCEL',
      projectId: process.env.VERCEL_PROJECT_ID ?? null,
      region: process.env.VERCEL_REGION ?? 'global',
      url,
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
      status: 'READY',
      lastHealthyAt: new Date(),
      health: { source: 'shared-platform', checkedAt: new Date().toISOString() },
    },
    create: {
      organizationId,
      environment: 'production',
      mode: 'SHARED',
      provider: 'VERCEL',
      projectId: process.env.VERCEL_PROJECT_ID ?? null,
      region: process.env.VERCEL_REGION ?? 'global',
      url,
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
      status: 'READY',
      lastHealthyAt: new Date(),
      health: { source: 'shared-platform', checkedAt: new Date().toISOString() },
    },
  });
  return { deploymentId: deployment.id, url, status: deployment.status };
}

function vercelConfiguration() {
  const configuration = vercelProvisioningConfiguration();
  if (!configuration) {
    throw new Error(
      'Dedicated provisioning is unavailable because Vercel provisioning is not configured for this environment. Choose shared provisioning or ask a platform administrator to configure Vercel.'
    );
  }
  return configuration;
}

/**
 * The two Vercel API groups the jobs call, loaded from their own entry points.
 * DEV-963: the package root declares every Vercel API (about 500 declaration
 * files) for the type check. `new Vercel(options).deployments` is exactly
 * `new Deployments(options)`, and likewise for `projects`.
 */
async function vercelClient(bearerToken: string) {
  const [{ Deployments }, { Projects }] = await Promise.all([
    import('@vercel/sdk/sdk/deployments.js'),
    import('@vercel/sdk/sdk/projects.js'),
  ]);
  return {
    deployments: new Deployments({ bearerToken }),
    projects: new Projects({ bearerToken }),
  };
}

async function dedicatedProvision(
  db: PrismaClient,
  job: PlatformJob,
  payload: JobPayload
): Promise<JobResult> {
  const organizationId = requiredOrganization(job);
  const { bearerToken, teamId } = vercelConfiguration();
  const [vercel, organization] = await Promise.all([
    vercelClient(bearerToken),
    db.organization.findUnique({
      where: { id: organizationId },
      select: { slug: true, displayName: true },
    }),
  ]);
  if (!organization) throw new Error('Organization no longer exists.');
  const deploymentRecord = await db.organizationDeployment.upsert({
    where: { organizationId_environment: { organizationId, environment: 'production' } },
    update: { mode: 'DEDICATED', status: 'PROVISIONING', provider: 'VERCEL' },
    create: {
      organizationId,
      environment: 'production',
      mode: 'DEDICATED',
      status: 'PROVISIONING',
      provider: 'VERCEL',
    },
  });
  const existingDeploymentId =
    typeof payload.vercelDeploymentId === 'string' ? payload.vercelDeploymentId : null;

  if (existingDeploymentId) {
    const deployment = await vercel.deployments.getDeployment({
      idOrUrl: existingDeploymentId,
      teamId,
      withGitRepoInfo: 'true',
    });
    const state = deployment.readyState;
    if (state === 'READY') {
      const url = deployment.url ? `https://${deployment.url}` : null;
      await db.organizationDeployment.update({
        where: { id: deploymentRecord.id },
        data: {
          status: 'READY',
          url,
          lastHealthyAt: new Date(),
          health: {
            vercelDeploymentId: deployment.id,
            readyState: state,
            checkedAt: new Date().toISOString(),
          },
        },
      });
      return { deploymentId: deploymentRecord.id, vercelDeploymentId: deployment.id, state, url };
    }
    if (state === 'ERROR' || state === 'CANCELED') {
      throw new Error(`Vercel deployment ended in ${state}.`);
    }
    await db.platformJob.create({
      data: {
        organizationId,
        type: 'PROVISION_DEDICATED',
        scheduledAt: new Date(Date.now() + 30_000),
        maxAttempts: job.maxAttempts,
        payload: { vercelDeploymentId: existingDeploymentId },
        idempotencyKey: `watch:${existingDeploymentId}:${Date.now()}`,
      },
    });
    return { deploymentId: deploymentRecord.id, vercelDeploymentId: deployment.id, state };
  }

  const gitOrg = process.env.VERCEL_GIT_REPO_ORG;
  const gitRepo = process.env.VERCEL_GIT_REPO_NAME;
  if (!gitOrg || !gitRepo) {
    throw new Error(
      'Dedicated provisioning requires VERCEL_GIT_REPO_ORG and VERCEL_GIT_REPO_NAME.'
    );
  }
  const projectName = `devfathom-${organization.slug}`.slice(0, 100);
  let project;
  try {
    project = await vercel.projects.getProject({ idOrName: projectName, teamId });
  } catch {
    project = await vercel.projects.createProject({
      teamId,
      requestBody: { name: projectName, framework: 'nextjs' },
    });
  }

  const environment = [
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['AUTH_SECRET', process.env.AUTH_SECRET],
    ['PLATFORM_ENCRYPTION_KEY', process.env.PLATFORM_ENCRYPTION_KEY],
    ['PLATFORM_BASE_DOMAIN', process.env.PLATFORM_BASE_DOMAIN],
    ['DEDICATED_ORGANIZATION_ID', organizationId],
  ] as const;
  for (const [key, value] of environment) {
    if (!value) continue;
    await vercel.projects.createProjectEnv({
      idOrName: project.id,
      teamId,
      upsert: 'true',
      requestBody: {
        key,
        value,
        type:
          key.includes('SECRET') || key.includes('KEY') || key === 'DATABASE_URL'
            ? 'encrypted'
            : 'plain',
        target: ['production', 'preview'],
      },
    });
  }
  const deployment = await vercel.deployments.createDeployment({
    teamId,
    skipAutoDetectionConfirmation: '1',
    requestBody: {
      name: projectName,
      project: project.id,
      target: 'production',
      gitSource: {
        type: 'github',
        org: gitOrg,
        repo: gitRepo,
        ref: process.env.VERCEL_GIT_REPO_REF ?? 'main',
      },
    },
  });
  await db.organizationDeployment.update({
    where: { id: deploymentRecord.id },
    data: {
      projectId: project.id,
      url: deployment.url ? `https://${deployment.url}` : null,
      health: {
        vercelDeploymentId: deployment.id,
        readyState: deployment.readyState,
        requestedAt: new Date().toISOString(),
      },
    },
  });
  await db.platformJob.create({
    data: {
      organizationId,
      type: 'PROVISION_DEDICATED',
      scheduledAt: new Date(Date.now() + 30_000),
      maxAttempts: job.maxAttempts,
      payload: { vercelDeploymentId: deployment.id },
      idempotencyKey: `watch:${deployment.id}:initial`,
    },
  });
  return {
    deploymentId: deploymentRecord.id,
    projectId: project.id,
    vercelDeploymentId: deployment.id,
    state: deployment.readyState,
  };
}

async function configureDomain(
  db: PrismaClient,
  job: PlatformJob,
  payload: JobPayload
): Promise<JobResult> {
  const organizationId = requiredOrganization(job);
  const domainId = requiredString(payload, 'domainId');
  const domain = await db.organizationDomain.findFirst({
    where: { id: domainId, organizationId },
    include: {
      organization: {
        select: {
          deployments: {
            where: { environment: 'production' },
            select: { projectId: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!domain) throw new Error('Domain no longer exists.');
  const verificationHost = `_devfathom-verification.${domain.host}`;
  let records: string[][] = [];
  try {
    records = await resolveTxt(verificationHost);
  } catch (error) {
    await db.organizationDomain.update({
      where: { id: domain.id },
      data: {
        verificationStatus: 'FAILED',
        lastCheckedAt: new Date(),
        failureReason: error instanceof Error ? error.message.slice(0, 500) : 'DNS lookup failed.',
      },
    });
    throw new Error(`Publish TXT ${verificationHost}=${domain.verificationToken}, then retry.`);
  }
  const verified = records.some((parts) => parts.join('') === domain.verificationToken);
  if (!verified) {
    await db.organizationDomain.update({
      where: { id: domain.id },
      data: {
        verificationStatus: 'FAILED',
        lastCheckedAt: new Date(),
        failureReason: 'Verification TXT value did not match.',
      },
    });
    throw new Error(`TXT ${verificationHost} does not match the verification token.`);
  }

  const { bearerToken, teamId } = vercelConfiguration();
  const vercel = await vercelClient(bearerToken);
  const projectId =
    domain.organization.deployments[0]?.projectId ?? process.env.VERCEL_PROJECT_ID ?? null;
  if (!projectId) throw new Error('No Vercel project is associated with this organization.');
  await vercel.projects.addProjectDomain({
    idOrName: projectId,
    teamId,
    requestBody: { name: domain.host },
  });
  await db.organizationDomain.update({
    where: { id: domain.id },
    data: {
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      lastCheckedAt: new Date(),
      failureReason: null,
    },
  });
  return { domainId: domain.id, host: domain.host, verificationHost, configured: true };
}

async function applyBrand(db: PrismaClient, job: PlatformJob): Promise<JobResult> {
  const organizationId = requiredOrganization(job);
  const brand = await db.organizationBrand.findUnique({ where: { organizationId } });
  if (!brand) throw new Error('Brand configuration is missing.');
  const version = createHash('sha256')
    .update(JSON.stringify({ ...brand, updatedAt: brand.updatedAt.toISOString() }))
    .digest('hex')
    .slice(0, 16);
  await db.organizationDeployment.updateMany({
    where: { organizationId, status: { not: 'DECOMMISSIONED' } },
    data: {
      health: {
        brandVersion: version,
        brandAppliedAt: new Date().toISOString(),
        source: 'organization-database',
      },
    },
  });
  return { brandId: brand.id, version, appliedAt: new Date().toISOString() };
}

async function syncIdentity(
  db: PrismaClient,
  job: PlatformJob,
  payload: JobPayload
): Promise<JobResult> {
  const organizationId = requiredOrganization(job);
  const connectionId = requiredString(payload, 'connectionId');
  const connection = await db.organizationIdentityConnection.findFirst({
    where: { id: connectionId, organizationId },
  });
  if (!connection) throw new Error('Identity connection no longer exists.');
  try {
    if (connection.protocol === 'OIDC') {
      if (!connection.clientId) throw new Error('OIDC client ID is required.');
      await discoverOidc(connection, connection.clientId, undefined, true);
    } else if (!connection.ssoUrl || !connection.entityId || !connection.certificate) {
      throw new Error('SAML SSO URL, entity ID, and signing certificate are required.');
    }
    await db.organizationIdentityConnection.update({
      where: { id: connection.id },
      data: { status: 'ACTIVE', lastTestedAt: new Date(), lastError: null },
    });
    return { connectionId: connection.id, protocol: connection.protocol, valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Identity validation failed.';
    await db.organizationIdentityConnection.update({
      where: { id: connection.id },
      data: { status: 'ERROR', lastTestedAt: new Date(), lastError: message.slice(0, 1_000) },
    });
    throw error;
  }
}

async function exportData(
  db: PrismaClient,
  job: PlatformJob,
  payload: JobPayload
): Promise<JobResult> {
  const organizationId = requiredOrganization(job);
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('Data exports require the provisioned BLOB_READ_WRITE_TOKEN.');
  }
  const [organization, users, clients, projects, tasks, invoices, transactions, auditLogs] =
    await Promise.all([
      db.organization.findUnique({
        where: { id: organizationId },
        select: {
          id: true,
          slug: true,
          legalName: true,
          displayName: true,
          timezone: true,
          locale: true,
          currency: true,
          createdAt: true,
        },
      }),
      db.user.findMany({
        where: { organizationId },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          department: true,
          title: true,
          status: true,
          startDate: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      db.client.findMany({ where: { organizationId } }),
      db.project.findMany({ where: { organizationId } }),
      db.task.findMany({ where: { organizationId } }),
      db.invoice.findMany({ where: { organizationId } }),
      db.transaction.findMany({ where: { organizationId } }),
      db.auditLog.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } }),
    ]);
  if (!organization) throw new Error('Organization no longer exists.');
  const generatedAt = new Date();
  const exportDocument = {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    requestedFields: Array.isArray(payload.resources) ? payload.resources : 'standard',
    organization,
    users,
    clients,
    projects,
    tasks,
    invoices,
    transactions,
    auditLogs,
  };
  const { put } = await import('@vercel/blob');
  const pathname = `private-exports/${organizationId}/${generatedAt.toISOString()}-${job.id}.json`;
  const blob = await put(pathname, JSON.stringify(exportDocument), {
    access: 'private',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  return {
    pathname: blob.pathname,
    url: blob.url,
    generatedAt: generatedAt.toISOString(),
    records:
      users.length +
      clients.length +
      projects.length +
      tasks.length +
      invoices.length +
      transactions.length +
      auditLogs.length,
  };
}

type TableDependency = {
  tableName: string;
  parentTable: string | null;
  /**
   * The referencing columns that may be set to NULL, for a foreign key that has
   * any. Under MATCH SIMPLE a composite key with one NULL member is not
   * enforced, so clearing these detaches the reference without touching the row
   * it points at. `null` marks a key that cannot be detached this way.
   */
  nullableColumns: string[] | null;
};

/** A reference cleared before the deletes, to break a cycle. See {@link deletionPlan}. */
type Detachment = { tableName: string; columns: string[] };

type DeletionPlan = { detach: Detachment[]; order: string[] };

/**
 * Order the tenant's tables so that every row is deleted before the rows it
 * refers to, and name the references that have to be cleared first.
 *
 * Mutual references are legitimate — a pharmacy branch names its default stock
 * location while every stock location belongs to a branch — but both sides are
 * ON DELETE RESTRICT, and RESTRICT fires immediately rather than at the end of
 * the statement, so neither table can be emptied while the other still points at
 * it. Where a cycle's edge is optional, clearing it is the resolution the schema
 * already allows: the pointer is nullable precisely because a branch need not
 * name a default location.
 *
 * A cycle with no optional edge is a schema defect rather than a purge-time
 * decision, and still throws.
 */
function deletionPlan(rows: TableDependency[]): DeletionPlan {
  const tables = new Set(
    rows.map((row) => row.tableName).filter((table) => !CONTROL_PLANE_TABLES.has(table))
  );
  const edges = rows.filter(
    (row) => row.parentTable && tables.has(row.tableName) && tables.has(row.parentTable)
  );
  const parents = new Map<string, Set<string>>();
  for (const table of tables) parents.set(table, new Set());
  for (const row of edges) parents.get(row.tableName)!.add(row.parentTable!);

  const detach: Detachment[] = [];
  const order: string[] = [];
  while (tables.size) {
    const children = [...tables].filter(
      (candidate) =>
        ![...tables].some((other) => other !== candidate && parents.get(other)?.has(candidate))
    );
    if (!children.length) {
      const optional = edges.find(
        (row) =>
          row.nullableColumns?.length && tables.has(row.tableName) && tables.has(row.parentTable!)
      );
      if (!optional) {
        throw new Error(
          `Tenant data contains a cyclic delete dependency with no optional reference to clear: ${[...tables].join(', ')}`
        );
      }
      detach.push({ tableName: optional.tableName, columns: optional.nullableColumns! });
      // Drop only this edge; the same pair may be joined by more than one key.
      edges.splice(edges.indexOf(optional), 1);
      parents.set(
        optional.tableName,
        new Set(
          edges.filter((row) => row.tableName === optional.tableName).map((row) => row.parentTable!)
        )
      );
      continue;
    }
    for (const child of children) {
      order.push(child);
      tables.delete(child);
    }
  }
  return { detach, order };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const AUDIT_LOG_PURGE_ACTION = 'organization.audit_logs.purge';
const DEFAULT_PURGE_REASON = 'Retention window elapsed and the organization is being purged.';

/**
 * Tenant audit rows are append-only (DEV-155). The database admits their
 * deletion only inside a control-plane purge of that tenant that has first
 * written a permanent `platform_audit_logs` record of what it removes, for which
 * organization, by which platform actor and why, and names that record in
 * "app.audit_purge_record_id". `platform_audit_logs` is itself append-only and
 * excluded from the purge, so the record outlives the tenant's data.
 */
async function recordAuditLogPurge(
  db: PrismaClient,
  job: PlatformJob,
  organizationId: string,
  actorPlatformUserId: string
): Promise<number> {
  const [summary] = await db.$queryRaw<
    Array<{ rows: number; earliest: Date | null; latest: Date | null; digest: string | null }>
  >(Prisma.sql`
    SELECT count(*)::int AS "rows",
           min("createdAt") AS "earliest",
           max("createdAt") AS "latest",
           encode(sha256(convert_to(string_agg("id", ',' ORDER BY "id"), 'UTF8')), 'hex') AS "digest"
    FROM "audit_logs"
    WHERE "organizationId" = ${organizationId}
  `);
  const requested = objectPayload(job.payload).reason;
  const reason =
    typeof requested === 'string' && requested.trim() ? requested.trim() : DEFAULT_PURGE_REASON;
  const record = await db.platformAuditLog.create({
    data: {
      organizationId,
      actorPlatformUserId,
      action: AUDIT_LOG_PURGE_ACTION,
      targetType: 'AuditLog',
      requestId: job.id,
      reason,
      metadata: {
        jobId: job.id,
        table: 'audit_logs',
        rows: summary?.rows ?? 0,
        earliestCreatedAt: summary?.earliest?.toISOString() ?? null,
        latestCreatedAt: summary?.latest?.toISOString() ?? null,
        idDigest: summary?.digest ? `sha256:${summary.digest}` : null,
      },
    },
    select: { id: true },
  });
  await db.$queryRaw`SELECT set_config('app.audit_purge_record_id', ${record.id}, true)`;
  return summary?.rows ?? 0;
}

async function purgeData(db: PrismaClient, job: PlatformJob): Promise<JobResult> {
  const organizationId = requiredOrganization(job);
  const actorPlatformUserId = job.requestedById;
  if (!actorPlatformUserId) {
    throw new PermanentJobError(
      'A purge requires the platform actor who requested it: this job names no requesting platform administrator. Schedule the purge again from the platform console.'
    );
  }
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { status: true, purgeScheduledAt: true },
  });
  if (!organization) throw new Error('Organization no longer exists.');
  if (organization.status !== 'PURGING') {
    throw new Error('Organization must be in PURGING state.');
  }
  if (!organization.purgeScheduledAt || organization.purgeScheduledAt > new Date()) {
    throw new Error('The retention window has not elapsed.');
  }
  const dependencies = await db.$queryRaw<TableDependency[]>(Prisma.sql`
    WITH tenant_tables AS (
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'organizationId'
    )
    SELECT child.relname AS "tableName",
           parent.relname AS "parentTable",
           (
             -- ::text because "attname" is the "name" type, which the driver
             -- adapter cannot deserialize as an array.
             SELECT array_agg(attribute.attname::text)
             FROM unnest(constraint_row.conkey) AS key(attnum)
             JOIN pg_attribute attribute
               ON attribute.attrelid = child.oid AND attribute.attnum = key.attnum
             WHERE NOT attribute.attnotnull
           ) AS "nullableColumns"
    FROM tenant_tables tt
    JOIN pg_class child
      ON child.relname = tt.table_name AND child.relnamespace = 'public'::regnamespace
    LEFT JOIN pg_constraint constraint_row
      ON constraint_row.conrelid = child.oid AND constraint_row.contype = 'f'
    LEFT JOIN pg_class parent ON parent.oid = constraint_row.confrelid
  `);
  const plan = deletionPlan(dependencies);
  // Authorise the destruction of this one tenant's append-only history. The
  // retention worker empties tenant tables individually rather than through a
  // cascade, so tables that refuse a bare DELETE — pharmacy onboarding events —
  // have no vanished parent row to recognise it by. Transaction-local, and
  // scoped to the organization this job names.
  await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${organizationId}, true)`;
  const recordedAuditRows = await recordAuditLogPurge(db, job, organizationId, actorPlatformUserId);
  // The customer and message rows below are about to be destroyed. Keep only
  // pseudonymous consent state and its effective date, never contact details or
  // message content, so a later complaint can be answered without retaining the
  // tenant's customer record.
  await archiveWhatsAppConsentBeforeTenantPurge(db, organizationId);
  for (const { tableName, columns } of plan.detach) {
    await db.$executeRawUnsafe(
      `UPDATE ${quoteIdentifier(tableName)} SET ${columns
        .map((column) => `${quoteIdentifier(column)} = NULL`)
        .join(', ')} WHERE "organizationId" = $1`,
      organizationId
    );
  }
  const counts: Record<string, number> = {};
  for (const table of plan.order) {
    const count = await db.$executeRawUnsafe(
      `DELETE FROM ${quoteIdentifier(table)} WHERE "organizationId" = $1`,
      organizationId
    );
    if (count) counts[table] = count;
  }
  // Audit rows are only ever added, so the DELETE saw every row the record
  // summarised; an equal count means it saw no others either. A row written
  // in between (a failed sign-in, say) would make the permanent record
  // understate the purge: roll everything back and let the job retry.
  if ((counts.audit_logs ?? 0) !== recordedAuditRows) {
    throw new Error(
      `Audit rows changed during the purge: recorded ${recordedAuditRows}, deleted ${counts.audit_logs ?? 0}.`
    );
  }
  await db.organization.update({
    where: { id: organizationId },
    data: { status: 'PURGED' },
  });
  await db.organizationLifecycleEvent.create({
    data: {
      organizationId,
      action: 'PURGED',
      fromStatus: 'PURGING',
      toStatus: 'PURGED',
      reason: 'Retention window elapsed and the automated purge completed.',
      metadata: { jobId: job.id, deletedRows: counts },
    },
  });
  return { organizationId, deletedRows: counts };
}

async function setDeploymentAvailability(
  db: PrismaClient,
  job: PlatformJob,
  suspended: boolean
): Promise<JobResult> {
  const organizationId = requiredOrganization(job);
  const now = new Date();
  const deployments = await db.organizationDeployment.updateMany({
    where: { organizationId, status: { not: 'DECOMMISSIONED' } },
    data: {
      status: suspended ? 'DEGRADED' : 'READY',
      lastHealthyAt: suspended ? undefined : now,
      health: {
        availability: suspended ? 'suspended' : 'active',
        changedAt: now.toISOString(),
        source: 'lifecycle-job',
      },
    },
  });
  if (suspended) {
    const { reason } = objectPayload(job.payload);
    await endSupportSessions(
      db,
      { organizationId },
      typeof reason === 'string' && reason.trim()
        ? `Organization suspended: ${reason.trim()}`
        : 'Organization suspended.',
      job.requestedById,
      'REVOKED'
    );
  }
  return { organizationId, deployments: deployments.count, suspended };
}

async function executeJob(job: PlatformJob): Promise<JobResult> {
  if (job.type === 'PASSWORD_RESET_REQUEST_V1') {
    const { runPasswordResetJob } = await import('@/lib/auth/password-reset-request');
    return runPasswordResetJob(job);
  }
  const jobType = job.type;
  return withPlatformDb(
    async (db) => {
      const payload = objectPayload(job.payload);
      const handlers: Record<
        Exclude<PlatformJobType, 'PASSWORD_RESET_REQUEST_V1'>,
        (database: PrismaClient, item: PlatformJob, data: JobPayload) => Promise<JobResult>
      > = {
        PROVISION_SHARED: sharedProvision,
        PROVISION_DEDICATED: dedicatedProvision,
        CONFIGURE_DOMAIN: configureDomain,
        APPLY_BRAND: (database, item) => applyBrand(database, item),
        SYNC_IDENTITY: syncIdentity,
        EXPORT_DATA: exportData,
        PURGE_DATA: (database, item) => purgeData(database, item),
        SUSPEND: (database, item) => setDeploymentAvailability(database, item, true),
        RESUME: (database, item) => setDeploymentAvailability(database, item, false),
        PHARMACY_CAMERA_SNAPSHOT_V1: runCounterEvidenceSnapshotJob,
        CAMERA_EVIDENCE_RETENTION_V1: (database, item) =>
          runCameraEvidenceRetentionJob(database, item),
        // DEV-96: the result (per-class counts, refused record ids and reasons;
        // never record contents) is stored on the job row. QA-3: each run
        // resumes where the last successful run's scan stopped, so records the
        // database keeps refusing cannot stall the purge behind them.
        PHARMACY_RECORD_RETENTION_V1: async (database) =>
          purgeExpiredPharmacyRecords(database, {
            resumeAfter: await previousRetentionPurgeResume(database),
          }),
        PHARMACY_OWNER_DATA_EXPORT_V1: runPharmacyOwnerDataExportJob,
      };
      return handlers[jobType](db, job, payload);
    },
    {
      timeout:
        job.type === 'EXPORT_DATA' ||
        job.type === 'PURGE_DATA' ||
        job.type === 'CAMERA_EVIDENCE_RETENTION_V1' ||
        job.type === 'PHARMACY_RECORD_RETENTION_V1' ||
        job.type === 'PHARMACY_OWNER_DATA_EXPORT_V1'
          ? 120_000
          : 30_000,
      // The owner export reads each table in pages, and some tables twice (sales
      // then sale lines). One snapshot keeps every file consistent with the rest.
      ...(job.type === 'PHARMACY_OWNER_DATA_EXPORT_V1'
        ? { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
        : {}),
    }
  );
}

const CAMERA_EVIDENCE_RELAY_LIMIT = 50;
const CAMERA_EVIDENCE_RETENTION_JOB = 'camera.evidence.retention.v1';
const PHARMACY_RECORD_RETENTION_JOB = 'pharmacy.record.retention.v1';

/**
 * CAM-2: turn pending counter evidence into snapshot jobs, and give every
 * organization with due retention work (a still past its gateway period, or a
 * capture past its window) at most one retention pass per UTC hour. DEV-96
 * adds one platform-wide pharmacy record retention purge per UTC hour. All are
 * keyed, so each worker run can repeat them without queueing anything twice.
 */
async function enqueueCameraEvidenceJobs(now: Date): Promise<void> {
  await withPlatformDb(async (db) => {
    const windowStart = new Date(now.getTime() - CAMERA_EVIDENCE_CAPTURE_WINDOW_MS);
    const pending = await db.$queryRaw<Array<{ id: string; organizationId: string }>>(Prisma.sql`
      SELECT e."id", e."organizationId"
      FROM "camera_evidence" e
      LEFT JOIN "platform_jobs" j
        ON j."idempotencyKey" = ${`${PHARMACY_CAMERA_SNAPSHOT_JOB}:`} || e."id"
      WHERE e."status" = 'PENDING' AND e."requestedAt" >= ${windowStart} AND j."id" IS NULL
      ORDER BY e."requestedAt" ASC, e."id" ASC
      LIMIT ${CAMERA_EVIDENCE_RELAY_LIMIT}
    `);
    const holders = await db.$queryRaw<Array<{ organizationId: string }>>(Prisma.sql`
      SELECT DISTINCT e."organizationId"
      FROM "camera_evidence" e
      JOIN "cameras" c ON c."organizationId" = e."organizationId" AND c."id" = e."cameraId"
      JOIN "camera_gateways" g ON g."organizationId" = c."organizationId" AND g."id" = c."gatewayId"
      WHERE (${cameraEvidenceDueSql(now)})
         OR (e."status" = 'PENDING' AND e."requestedAt" < ${windowStart})
    `);
    const hour = now.toISOString().slice(0, 13);
    await db.platformJob.createMany({
      data: [
        ...pending.map((evidence) => ({
          organizationId: evidence.organizationId,
          type: 'PHARMACY_CAMERA_SNAPSHOT_V1' as const,
          payload: { evidenceId: evidence.id },
          idempotencyKey: `${PHARMACY_CAMERA_SNAPSHOT_JOB}:${evidence.id}`,
        })),
        ...holders.map(({ organizationId }) => ({
          organizationId,
          type: 'CAMERA_EVIDENCE_RETENTION_V1' as const,
          idempotencyKey: `${CAMERA_EVIDENCE_RETENTION_JOB}:${organizationId}:${hour}`,
        })),
        // DEV-96: one pharmacy record retention purge per UTC hour, platform-wide.
        {
          organizationId: null,
          type: 'PHARMACY_RECORD_RETENTION_V1' as const,
          idempotencyKey: `${PHARMACY_RECORD_RETENTION_JOB}:${hour}`,
        },
      ],
      skipDuplicates: true,
    });
  });
}

export type ProcessJobsResult = {
  recovered: number;
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
};

export async function processPlatformJobs(maxJobs = 10): Promise<ProcessJobsResult> {
  const limit = Math.max(1, Math.min(100, Math.floor(maxJobs)));
  // Bound each five-minute cleanup pass and release locks between batches.
  for (let batch = 0; batch < 16; batch++) {
    if ((await withPlatformDb(deleteSpentSsoStates)) < SSO_CLEANUP_BATCH_SIZE) break;
  }
  await withPlatformDb((db) => deleteExpiredWhatsAppConsentArchives(db));
  await withPlatformDb((db) => purgeExpiredOwnerDataExports(db));
  await enqueueCameraEvidenceJobs(new Date());
  const result: ProcessJobsResult = {
    recovered: await recoverStaleJobs(),
    claimed: 0,
    succeeded: 0,
    retried: 0,
    failed: 0,
  };
  for (let index = 0; index < limit; index += 1) {
    const job = await claimJob();
    if (!job) break;
    result.claimed += 1;
    const status = await runClaimedJob(
      job,
      executeJob,
      (error) =>
        error instanceof PermanentJobError ||
        error instanceof OwnerDataExportTooLargeError ||
        error instanceof OwnerDataExportTimeLimitError
    );
    result[status] += 1;
  }
  return result;
}
