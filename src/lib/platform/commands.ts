import 'server-only';

import { hash } from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  Prisma,
  type LifecycleAction,
  type OrganizationIdentityConnection,
  type OrganizationStatus,
  type PlatformJob,
  type PrismaClient,
} from '@/generated/prisma/client';
import type { PlatformIdentity } from '@/lib/platform/auth';
import { assertPlatformCapability } from '@/lib/platform/auth';
import { PlatformSecurityError } from '@/lib/platform/security';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { encryptSecret } from '@/lib/secret-crypto';
import { emailSchema } from '@/lib/email-address';
import { isReservedHostLabel, RESERVED_HOST_LABELS } from '@/lib/tenancy/host-routing';
import { OrganizationVertical } from '@/generated/prisma/enums';
import {
  adminDepartmentKeyForVertical,
  defaultDepartmentRowsForVertical,
  isPackageCompatibleWithVertical,
  mandatoryModulesForVertical,
  modulesForVertical,
  roleTemplatesForVertical,
} from '@/lib/vertical-catalog';
import { moduleDefinitionForKey, verticalForModuleKey } from '@/lib/module-catalog';
import {
  assertStoredBranchMayOperate,
  BranchOperationDeniedError,
} from '@/lib/pharmacy/regulatory';
import { evaluatePharmacyReadiness } from '@/lib/pharmacy/onboarding';

const id = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const optionalId = id.nullish().transform((value) => value || null);
const requiredText = z.string().trim().min(1).max(500);
const optionalText = z
  .string()
  .trim()
  .max(5_000)
  .nullish()
  .transform((value) => value || null);
// D10: trims and lower-cases BEFORE validating, so a padded or upper-cased
// address from an operator form is normalized rather than rejected as malformed.
const email = emailSchema;
const currency = z
  .string()
  .trim()
  .length(3)
  .transform((value) => value.toUpperCase());
const date = z.iso.datetime().transform((value) => new Date(value));
const optionalDate = z.iso
  .datetime()
  .nullish()
  .transform((value) => (value ? new Date(value) : null));
const money = z.coerce.number().finite().min(0).max(999_999_999_999);
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  // D3: a slug becomes `<slug>.<baseDomain>`. Assigning one of the reserved
  // labels would shadow the control plane or the shared application host, so it
  // is refused at creation rather than discovered as a routing collision.
  .refine((value) => !isReservedHostLabel(value), {
    message: `Reserved slug. Choose another: ${RESERVED_HOST_LABELS.join(', ')} are used by the platform.`,
  });
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
// §2 — the organization operating model. The literal values come from the
// generated Prisma enum, so the vertical list is never re-typed here.
const vertical = z.enum(OrganizationVertical);
const businessDayCutoff = z
  .string()
  .trim()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, e.g. 09:30');
const ianaTimezone = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Choose a valid IANA timezone.');

const COMMAND_CAPABILITY: Record<string, string> = {
  organization: 'organizations:write',
  crm: 'crm:write',
  commercial: 'commercial:write',
  catalog: 'catalog:write',
  deployment: 'deployments:write',
  job: 'jobs:write',
  operator: 'operators:write',
  setting: 'settings:write',
};

const TRANSITIONS: Record<OrganizationStatus, readonly OrganizationStatus[]> = {
  PROSPECT: ['ONBOARDING', 'TERMINATED'],
  ONBOARDING: ['ACTIVE', 'SUSPENDED', 'TERMINATED'],
  ACTIVE: ['GRACE', 'SUSPENDED', 'TERMINATED'],
  GRACE: ['ACTIVE', 'SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],
  TERMINATED: ['PURGING'],
  // PURGED is written only by the retention worker after data destruction.
  PURGING: [],
  PURGED: [],
};

/**
 * One command result, three audiences. They are separate fields because they
 * are separate decisions, and the old single object made the wrong one twice:
 * a key-name regex both missed `token` (a live SCIM credential reached the
 * audit table in cleartext) and matched `encrypted` (ciphertext was replaced
 * with '[REDACTED]' on its way into the settings row). See issue #10.
 *
 *  PERSIST  what the case body writes to the database. Plain `toJson`, never
 *           rewritten on its way there.
 *  REVEAL   `data`. Returned to the authorized operator, once. Never audited.
 *  AUDIT    `audit` / `auditBefore`. The only values written to
 *           platform_audit_logs. Never a credential, never ciphertext.
 *
 * `audit` is required, so a command cannot acquire an audit projection by
 * accident: a new case that declares none does not compile, and if one reaches
 * the writer untyped it logs an empty object rather than the reveal payload.
 *
 * CONTRACT. `audit` and `auditBefore` are written to the ledger verbatim.
 * Nothing between the case body and `platform_audit_logs` inspects, filters, or
 * rewrites them: there is no recursive walk and no key-name matching, because
 * that is exactly the mechanism issue #10 removed. An audit projection is
 * therefore intentionally explicit and shallow — it names the top-level keys it
 * drops (see `omit`) and nothing deeper.
 *
 * The obligation this places on every case: any field a command keeps in its
 * audit projection that could hold a credential or a secret — a token, a
 * password, ciphertext, an operator-supplied JSON blob, a provider
 * configuration — must be explicitly omitted or replaced with a sanitized
 * summary by that command's own projection. Nothing downstream will catch it.
 */
type CommandResult = {
  targetType: string;
  targetId?: string | null;
  /** REVEAL: returned to the operator. Never written to the audit log. */
  data: unknown;
  /** AUDIT: written verbatim to platform_audit_logs.after. */
  audit: unknown;
  organizationId?: string | null;
  /** AUDIT: written verbatim to platform_audit_logs.before. Omitted logs nothing. */
  auditBefore?: unknown;
};

/** Structural JSON cast. Redacts nothing: persistence must keep what it stores. */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/** Copy of `value` without `keys`. An audit projection names its omissions here. */
function omit<T extends object, K extends keyof T>(value: T, ...keys: readonly K[]): Omit<T, K> {
  const dropped = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !dropped.has(key))) as Omit<
    T,
    K
  >;
}

/**
 * Audit projection for an identity connection. The client secret is ciphertext
 * and `roleMappings` / `configuration` are operator-supplied blobs that can
 * carry provider credentials; none of the three belongs in the ledger.
 */
function identityConnectionAudit(connection: OrganizationIdentityConnection) {
  return {
    ...omit(connection, 'encryptedClientSecret', 'roleMappings', 'configuration'),
    clientSecretConfigured: Boolean(connection.encryptedClientSecret),
  };
}

/**
 * Audit projection for a job the operator supplied a payload for. The payload
 * and the worker result are arbitrary operator/worker JSON; the jobs table
 * keeps them, the ledger records the job itself.
 */
function jobAudit(job: PlatformJob) {
  return omit(job, 'payload', 'result');
}

/**
 * The audit row's before/after. Fails closed: a result with no declared
 * projection records an empty object, never the reveal payload.
 */
export function auditProjection(result: Pick<CommandResult, 'audit' | 'auditBefore'>): {
  before: Prisma.InputJsonValue | undefined;
  after: Prisma.InputJsonValue;
} {
  return {
    before: result.auditBefore === undefined ? undefined : toJson(result.auditBefore),
    after: toJson(result.audit ?? {}),
  };
}

function capabilityFor(action: string): string {
  const domain = action.split('.')[0] ?? '';
  const capability = COMMAND_CAPABILITY[domain];
  if (!capability) throw new PlatformSecurityError('Unknown platform command.', 400);
  return capability;
}

const auditId = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);

type FailureCategory = 'capability_denied' | 'validation_failed' | 'command_failed';

const FAILURE_REASON: Record<FailureCategory, string> = {
  capability_denied: 'Platform command capability denied.',
  validation_failed: 'Platform command validation failed.',
  command_failed: 'Platform command transaction failed.',
};

function failureCategory(error: unknown): FailureCategory {
  if (error instanceof PlatformSecurityError && error.status === 403) return 'capability_denied';
  if (
    error instanceof z.ZodError ||
    (error instanceof PlatformSecurityError && error.status === 400)
  ) {
    return 'validation_failed';
  }
  return 'command_failed';
}

function safeFailureTarget(action: string, payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const candidate = payload as Record<string, unknown>;
  const organizationId = auditId.safeParse(candidate.organizationId);
  return {
    organizationId: organizationId.success ? organizationId.data : undefined,
    targetType: action === 'platform.command.invalid' ? undefined : action.split('.')[0],
  };
}

async function persistCommandFailure(
  actor: PlatformIdentity,
  action: string,
  payload: unknown,
  request: Request,
  error: unknown
) {
  const category = failureCategory(error);
  const correlation = requestId.safeParse(request.headers.get('x-devfathom-request-id'));
  const correlationId = correlation.success
    ? `pcorr_${createHash('sha256').update(correlation.data).digest('hex').slice(0, 32)}`
    : undefined;
  const deterministicId = correlationId
    ? `pcfail_${createHash('sha256')
        .update(`${actor.id}\0${action}\0${category}\0${correlationId}`)
        .digest('hex')
        .slice(0, 32)}`
    : undefined;

  try {
    await withPlatformDb(async (db) => {
      const target = safeFailureTarget(action, payload);
      if (target.organizationId) {
        const organization = await db.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM organizations WHERE id = $1 FOR KEY SHARE',
          target.organizationId
        );
        if (organization.length === 0) target.organizationId = undefined;
      }

      try {
        await db.platformAuditLog.create({
          data: {
            ...(deterministicId ? { id: deterministicId } : {}),
            ...target,
            actorPlatformUserId: actor.id,
            action,
            metadata: { outcomeCategory: category },
            requestId: correlationId,
            reason: FAILURE_REASON[category],
            success: false,
            error: FAILURE_REASON[category],
          },
        });
      } catch (auditError) {
        if (
          deterministicId &&
          typeof auditError === 'object' &&
          auditError !== null &&
          'code' in auditError &&
          auditError.code === 'P2002'
        ) {
          return;
        }
        throw auditError;
      }
    });
  } catch {
    // Operational signal is deliberately constant: neither the command error nor
    // attacker-controlled input is safe to emit when the audit sink is unhealthy.
    console.error('[platform-audit] failed to persist command failure');
    throw new PlatformSecurityError(
      'The platform command failed and its audit record could not be persisted.',
      500
    );
  }
}

function lifecycleAction(from: OrganizationStatus, to: OrganizationStatus): LifecycleAction {
  if (to === 'ACTIVE') return from === 'SUSPENDED' ? 'RESUMED' : 'ACTIVATED';
  if (to === 'GRACE') return 'ENTERED_GRACE';
  if (to === 'SUSPENDED') return 'SUSPENDED';
  if (to === 'TERMINATED') return 'TERMINATED';
  if (to === 'PURGING') return 'PURGE_SCHEDULED';
  if (to === 'PURGED') return 'PURGED';
  return 'CREATED';
}

async function assertActivationReady(db: PrismaClient, organizationId: string) {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    include: {
      package: { include: { moduleLinks: { where: { enabled: true } } } },
      modules: { where: { status: { in: ['ENABLED', 'TRIAL'] } } },
      users: { where: { role: 'ADMIN', status: { in: ['ACTIVE', 'ON_LEAVE'] } }, take: 1 },
      deployments: { where: { environment: 'production', status: 'READY' }, take: 1 },
    },
  });
  if (!organization) throw new PlatformSecurityError('Organization not found.', 400);
  const missing = [
    !organization.packageId ? 'commercial package' : null,
    organization.modules.length + (organization.package?.moduleLinks.length ?? 0) === 0
      ? 'enabled module'
      : null,
    organization.users.length === 0 ? 'active organization administrator' : null,
    organization.deployments.length === 0 ? 'ready production deployment' : null,
  ].filter(Boolean);
  if (missing.length) {
    throw new PlatformSecurityError(`Activation preflight failed: add ${missing.join(', ')}.`, 400);
  }

  if (organization.vertical === 'PHARMACY') {
    const now = new Date();
    const profile = await db.branchRegulatoryProfile.findFirst({
      where: {
        organizationId,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { branchId: true },
      orderBy: { effectiveFrom: 'desc' },
    });
    try {
      await assertStoredBranchMayOperate(
        db,
        organizationId,
        profile?.branchId ?? 'activation-preflight',
        { name: 'ACTIVATE', at: now, requiresQualifiedPerson: true }
      );
    } catch (error) {
      if (error instanceof BranchOperationDeniedError) {
        throw new PlatformSecurityError(
          `Activation preflight failed: pharmacy regulatory profile denied operation (${error.reason}).`,
          400
        );
      }
      throw error;
    }

    // PLAT-03 — every P0 onboarding gate must be PASSED, and readiness is
    // recomputed here rather than read off the stored gate rows. A seeded or
    // bootstrapped PASSED with no evidence behind it is downgraded by
    // `evaluatePharmacyReadiness` before it is counted, so activation cannot be
    // reached by writing rows.
    const readiness = await evaluatePharmacyReadiness(db, organizationId, now);
    if (!readiness.ready) {
      throw new PlatformSecurityError(
        `Activation preflight failed: pharmacy onboarding gates not passed (${readiness.blocking.join(', ')}).`,
        400
      );
    }
    return;
  }

  // §9 Step 7 — restaurant activation preflight (the implementable subset). The
  // agency path is complete above and returns here with byte-identical behavior;
  // the checks below only run for restaurant organizations. Operator credential
  // and device-policy checks are deferred with D11.
  if (organization.vertical !== 'RESTAURANT') return;

  const restaurantMissing: string[] = [];

  // §2.3 — the assigned package must belong to the restaurant vertical.
  if (
    !organization.package ||
    !isPackageCompatibleWithVertical(
      organization.package.vertical ?? 'AGENCY',
      organization.vertical
    )
  ) {
    restaurantMissing.push('a restaurant-compatible commercial package');
  }

  // Resolve the effective set of enabled restaurant module keys: the package
  // baseline (inherited live) with organization overrides layered on top, in the
  // resolver's package → override order. Only restaurant modules are relevant, so
  // ids are mapped to keys through the catalog's restaurant module set.
  const restaurantModuleKeys = modulesForVertical('RESTAURANT').map((module) => module.key);
  const restaurantCatalogModules = await db.platformModule.findMany({
    where: { key: { in: restaurantModuleKeys } },
    select: { id: true, key: true },
  });
  const keyByModuleId = new Map(
    restaurantCatalogModules.map((module) => [module.id, module.key] as const)
  );
  const enabledKeys = new Set<string>();
  for (const link of organization.package?.moduleLinks ?? []) {
    const key = keyByModuleId.get(link.moduleId);
    if (key) enabledKeys.add(key);
  }
  const moduleOverrides = await db.organizationModule.findMany({
    where: { organizationId },
    select: { moduleId: true, status: true },
  });
  for (const override of moduleOverrides) {
    const key = keyByModuleId.get(override.moduleId);
    if (!key) continue;
    if (override.status === 'ENABLED' || override.status === 'TRIAL') enabledKeys.add(key);
    else enabledKeys.delete(key);
  }

  // §6.1 — Restaurant Core is mandatory; §9 Step 7 additionally requires at least
  // one operational module enabled beyond it.
  const coreKeys = mandatoryModulesForVertical('RESTAURANT').map((module) => module.key);
  if (!coreKeys.every((key) => enabledKeys.has(key))) {
    restaurantMissing.push('the mandatory Restaurant Core module');
  }
  const additionalOperational = [...enabledKeys].filter((key) => !coreKeys.includes(key));
  if (additionalOperational.length === 0) {
    restaurantMissing.push('at least one additional restaurant operational module');
  }

  // §4 / §9 Steps 3/5 — exactly one active default branch.
  const defaultBranches = await db.restaurantBranch.findMany({
    where: { organizationId, isDefault: true, active: true },
    select: { id: true, name: true, address: true, timezone: true, businessDayCutoff: true },
  });
  if (defaultBranches.length !== 1) {
    restaurantMissing.push('exactly one active default restaurant branch');
  } else {
    const branch = defaultBranches[0]!;
    if (!branch.name?.trim()) restaurantMissing.push('a nonblank default branch name');
    if (!branch.address?.trim()) restaurantMissing.push('a default branch address');
    if (!ianaTimezone.safeParse(branch.timezone ?? '').success)
      restaurantMissing.push('a valid default branch IANA timezone');
    if (!businessDayCutoff.safeParse(branch.businessDayCutoff ?? '').success)
      restaurantMissing.push('a valid default branch business-day cutoff');
  }

  const acknowledgements = await db.restaurantActivationAcknowledgement.findMany({
    where: { organizationId },
    select: { kind: true, policyReference: true },
  });
  const acknowledgedKinds = new Set(
    acknowledgements.filter((row) => row.policyReference.trim()).map((row) => row.kind)
  );
  for (const kind of ['TAX', 'PAYMENT', 'DEVICE', 'OPERATOR'] as const) {
    if (!acknowledgedKinds.has(kind))
      restaurantMissing.push(`${kind.toLowerCase()} policy acknowledgement`);
  }

  if (restaurantMissing.length) {
    throw new PlatformSecurityError(
      `Activation preflight failed: add ${restaurantMissing.join(', ')}.`,
      400
    );
  }
}

async function syncContractEntitlements(
  db: PrismaClient,
  actor: PlatformIdentity,
  input: {
    organizationId: string;
    number: string;
    status: string;
    seatLimit: number;
    endDate: Date;
    graceUntil: Date | null;
    moduleIds: string[];
  }
) {
  if (!['ACTIVE', 'GRACE', 'RENEWAL_DUE'].includes(input.status)) return;
  const catalogModules = await db.platformModule.findMany({
    where: { active: true },
    select: { id: true },
  });
  const included = new Set(input.moduleIds);
  const expiresAt = input.graceUntil ?? input.endDate;
  for (const catalogModule of catalogModules) {
    const enabled = included.has(catalogModule.id);
    await db.organizationModule.upsert({
      where: {
        organizationId_moduleId: {
          organizationId: input.organizationId,
          moduleId: catalogModule.id,
        },
      },
      update: {
        status: enabled ? 'ENABLED' : 'DISABLED',
        expiresAt: enabled ? expiresAt : null,
        reason: `Contract ${input.number}`,
        changedById: actor.id,
      },
      create: {
        organizationId: input.organizationId,
        moduleId: catalogModule.id,
        status: enabled ? 'ENABLED' : 'DISABLED',
        expiresAt: enabled ? expiresAt : null,
        reason: `Contract ${input.number}`,
        changedById: actor.id,
      },
    });
  }
  await db.organization.update({
    where: { id: input.organizationId },
    data: { seatLimit: input.seatLimit },
  });
}

const organizationInput = z
  .object({
    // §2 — default AGENCY keeps every existing onboarding payload valid.
    vertical: vertical.default('AGENCY'),
    slug,
    legalName: requiredText,
    displayName: requiredText,
    deploymentMode: z.enum(['SHARED', 'DEDICATED']).default('SHARED'),
    packageId: id,
    timezone: z.string().trim().min(1).max(100).default('UTC'),
    locale: z.string().trim().min(2).max(20).default('en'),
    currency: currency.default('USD'),
    // Legacy callers may omit seats; the selected package supplies the baseline.
    seatLimit: z.coerce.number().int().min(1).max(100_000).optional(),
    gracePeriodDays: z.coerce.number().int().min(0).max(365).default(0),
    dataResidency: optionalText.optional(),
    primaryContactName: requiredText,
    primaryContactEmail: email,
    notes: optionalText.optional(),
    adminName: requiredText,
    adminEmail: email,
    adminPassword: z.string().min(12).max(256),
    opportunityId: optionalId.optional(),
    firstBranchName: z.string().trim().min(2).max(120).optional(),
    firstBranchAddress: z.string().trim().min(1).max(300).optional(),
    businessDayCutoff: businessDayCutoff.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.vertical !== 'RESTAURANT') return;
    for (const field of ['firstBranchName', 'firstBranchAddress', 'businessDayCutoff'] as const) {
      if (!input[field])
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'Required for Restaurant organizations.',
        });
    }
    const timezone = ianaTimezone.safeParse(input.timezone);
    if (!timezone.success)
      ctx.addIssue({
        code: 'custom',
        path: ['timezone'],
        message: 'Choose a valid IANA timezone.',
      });
  });

async function bootstrapOrganization(
  db: PrismaClient,
  actor: PlatformIdentity,
  input: z.infer<typeof organizationInput>
) {
  const packageRecord = await db.platformPackage.findUnique({
    where: { id: input.packageId },
    include: { moduleLinks: { where: { enabled: true } } },
  });
  if (!packageRecord?.active) {
    throw new PlatformSecurityError('Choose an active commercial package.', 400);
  }
  // §2.3 — the package must belong to the chosen vertical. Onboarding filters the
  // choices, but the server rejects a mismatch even from a crafted request. The
  // vertical column is NOT NULL DEFAULT 'AGENCY', so a nullish value is read as
  // AGENCY (faithful to the schema default).
  if (!isPackageCompatibleWithVertical(packageRecord.vertical ?? 'AGENCY', input.vertical)) {
    throw new PlatformSecurityError(
      `The selected package is not available for the ${input.vertical} vertical.`,
      400
    );
  }
  const password = await hash(input.adminPassword, 12);
  const organization = await db.organization.create({
    data: {
      slug: input.slug,
      legalName: input.legalName,
      displayName: input.displayName,
      vertical: input.vertical,
      status: 'ONBOARDING',
      deploymentMode: input.deploymentMode,
      packageId: input.packageId,
      timezone: input.timezone,
      locale: input.locale,
      currency: input.currency,
      seatLimit: input.seatLimit ?? packageRecord.defaultSeats,
      gracePeriodDays: input.gracePeriodDays,
      dataResidency: input.dataResidency,
      primaryContactName: input.primaryContactName,
      primaryContactEmail: input.primaryContactEmail,
      notes: input.notes,
    },
  });
  const adminRole = await db.organizationRole.create({
    data: {
      organizationId: organization.id,
      key: 'admin',
      name: 'Organization administrator',
      description: 'Full organization administration',
      isSystem: true,
      permissions: {
        create: [{ organizationId: organization.id, capability: '*', effect: 'ALLOW' }],
      },
    },
  });
  // WHA-278 — seed the tenant's department catalog from the vertical catalog
  // before any user exists. `User.department` is a composite foreign key onto
  // `organization_departments`, so the administrator below cannot be created
  // until its vertical's departments are present.
  await db.organizationDepartment.createMany({
    data: defaultDepartmentRowsForVertical(input.vertical).map((department) => ({
      organizationId: organization.id,
      ...department,
    })),
  });
  // D20: the operator onboarding form had no duplicate guard at all — a repeat
  // submission would have surfaced a raw Prisma unique-constraint error in the
  // control plane. The organization is new, so a clash can only come from a
  // concurrent create; report it as a conflict either way.
  const existingAdmin = await db.user.findFirst({
    where: { organizationId: organization.id, email: input.adminEmail },
    select: { id: true },
  });
  if (existingAdmin) {
    throw new PlatformSecurityError('A user with this email already exists.', 409);
  }
  const admin = await db.user.create({
    data: {
      organizationId: organization.id,
      organizationRoleId: adminRole.id,
      name: input.adminName,
      email: input.adminEmail,
      password,
      role: 'ADMIN',
      department: adminDepartmentKeyForVertical(input.vertical),
      title: 'Organization administrator',
      status: 'ACTIVE',
    },
  });
  // §9 Steps 3/5/6 — restaurant onboarding is branch-first. Create the single
  // default branch (organization timezone, conservative name), assign the
  // bootstrap administrator to it, and instantiate the restaurant role templates
  // from the catalog. Guarded so the AGENCY path is byte-identical.
  if (input.vertical === 'RESTAURANT') {
    const defaultBranch = await db.restaurantBranch.create({
      data: {
        organizationId: organization.id,
        name: input.firstBranchName!,
        code: 'MAIN',
        timezone: input.timezone,
        address: input.firstBranchAddress!,
        businessDayCutoff: input.businessDayCutoff!,
        isDefault: true,
      },
    });
    await db.restaurantBranchAssignment.create({
      data: {
        organizationId: organization.id,
        branchId: defaultBranch.id,
        userId: admin.id,
      },
    });
    for (const template of roleTemplatesForVertical(input.vertical)) {
      await db.organizationRole.create({
        data: {
          organizationId: organization.id,
          key: template.key,
          name: template.name,
          isSystem: template.isSystem,
          permissions: {
            create: template.capabilities.map((capability) => ({
              organizationId: organization.id,
              capability,
              effect: 'ALLOW',
            })),
          },
        },
      });
    }
  }
  // §2.3: onboarding no longer copies the package's enabled modules into
  // OrganizationModule. Those rows behave as permanent OVERRIDEs in the resolver
  // (src/lib/entitlements.ts) and stranded when the package later changed. The
  // package baseline is inherited live from platform_package_modules instead;
  // only operator/contract deviations write OrganizationModule rows.
  await db.organizationBrand.create({ data: { organizationId: organization.id } });
  await db.organizationEmailSettings.create({ data: { organizationId: organization.id } });
  await db.organizationDeployment.create({
    data: {
      organizationId: organization.id,
      environment: 'production',
      mode: input.deploymentMode,
      status: 'PENDING',
    },
  });
  await db.platformJob.create({
    data: {
      organizationId: organization.id,
      type: input.deploymentMode === 'DEDICATED' ? 'PROVISION_DEDICATED' : 'PROVISION_SHARED',
      requestedById: actor.id,
      payload: { environment: 'production' },
      idempotencyKey: `provision:${organization.id}:production`,
    },
  });
  await db.organizationLifecycleEvent.create({
    data: {
      organizationId: organization.id,
      action: 'CREATED',
      toStatus: 'ONBOARDING',
      reason: 'Organization created by platform operator',
      actorId: actor.id,
    },
  });
  if (input.opportunityId) {
    const opportunity = await db.platformOpportunity.findUnique({
      where: { id: input.opportunityId },
      select: { id: true, accountId: true, stage: true },
    });
    if (opportunity) {
      await db.platformOpportunity.update({
        where: { id: opportunity.id },
        data: {
          stage: 'WON',
          wonAt: new Date(),
          convertedOrganizationId: organization.id,
        },
      });
      await db.platformOpportunityStageEvent.create({
        data: {
          opportunityId: opportunity.id,
          fromStage: opportunity.stage,
          toStage: 'WON',
          changedById: actor.id,
          reason: 'Converted into an organization',
        },
      });
      await db.platformAccount.update({
        where: { id: opportunity.accountId },
        data: { organizationId: organization.id, status: 'CUSTOMER' },
      });
    }
  }
  return organization;
}

async function runCommand(
  db: PrismaClient,
  actor: PlatformIdentity,
  action: string,
  payload: unknown
): Promise<CommandResult> {
  switch (action) {
    case 'organization.create': {
      const input = organizationInput.parse(payload);
      const organization = await bootstrapOrganization(db, actor, input);
      return {
        targetType: 'Organization',
        targetId: organization.id,
        organizationId: organization.id,
        data: organization,
        audit: organization,
      };
    }
    case 'organization.restaurant.setup': {
      const input = z
        .object({
          organizationId: id,
          branchName: z.string().trim().min(2).max(120),
          address: z.string().trim().min(1).max(300),
          timezone: ianaTimezone,
          businessDayCutoff,
          taxAcknowledged: z.literal(true),
          taxPolicyReference: z.string().trim().min(1).max(300),
          paymentAcknowledged: z.literal(true),
          paymentPolicyReference: z.string().trim().min(1).max(300),
          deviceAcknowledged: z.literal(true),
          devicePolicyReference: z.string().trim().min(1).max(300),
          operatorAcknowledged: z.literal(true),
          operatorPolicyReference: z.string().trim().min(1).max(300),
        })
        .parse(payload);
      const organization = await db.organization.findUnique({
        where: { id: input.organizationId },
        select: { vertical: true, status: true },
      });
      if (!organization) throw new PlatformSecurityError('Organization not found.', 400);
      if (organization.vertical !== 'RESTAURANT')
        throw new PlatformSecurityError(
          'Restaurant setup is only available to Restaurant organizations.',
          400
        );
      if (['TERMINATED', 'PURGING', 'PURGED'].includes(organization.status))
        throw new PlatformSecurityError(
          'Restaurant setup is unavailable for a terminal organization.',
          400
        );
      const branches = await db.restaurantBranch.findMany({
        where: { organizationId: input.organizationId, isDefault: true, active: true },
        select: { id: true, name: true, address: true, timezone: true, businessDayCutoff: true },
      });
      if (branches.length !== 1)
        throw new PlatformSecurityError(
          'Restaurant setup requires exactly one active default branch.',
          400
        );
      const branch = branches[0]!;
      const beforeAcknowledgements = await db.restaurantActivationAcknowledgement.findMany({
        where: { organizationId: input.organizationId },
        select: { kind: true, policyReference: true, acknowledgedById: true, acknowledgedAt: true },
      });
      const savedBranch = await db.restaurantBranch.update({
        where: { id: branch.id },
        data: {
          name: input.branchName,
          address: input.address,
          timezone: input.timezone,
          businessDayCutoff: input.businessDayCutoff,
        },
      });
      const references = {
        TAX: input.taxPolicyReference,
        PAYMENT: input.paymentPolicyReference,
        DEVICE: input.devicePolicyReference,
        OPERATOR: input.operatorPolicyReference,
      } as const;
      const savedAcknowledgements = [];
      for (const [kind, policyReference] of Object.entries(references)) {
        savedAcknowledgements.push(
          await db.restaurantActivationAcknowledgement.upsert({
            where: {
              organizationId_kind: {
                organizationId: input.organizationId,
                kind: kind as keyof typeof references,
              },
            },
            update: { policyReference, acknowledgedById: actor.id, acknowledgedAt: new Date() },
            create: {
              organizationId: input.organizationId,
              kind: kind as keyof typeof references,
              policyReference,
              acknowledgedById: actor.id,
            },
          })
        );
      }
      const beforeProjection = { branch, acknowledgements: beforeAcknowledgements };
      const afterProjection = { branch: savedBranch, acknowledgements: savedAcknowledgements };
      return {
        targetType: 'RestaurantActivationSetup',
        targetId: input.organizationId,
        organizationId: input.organizationId,
        auditBefore: beforeProjection,
        data: afterProjection,
        audit: afterProjection,
      };
    }
    case 'organization.update': {
      const input = z
        .object({
          id,
          displayName: requiredText.optional(),
          legalName: requiredText.optional(),
          vertical: vertical.optional(),
          packageId: optionalId.optional(),
          deploymentMode: z.enum(['SHARED', 'DEDICATED']).optional(),
          timezone: z.string().min(1).max(100).optional(),
          locale: z.string().min(2).max(20).optional(),
          currency: currency.optional(),
          seatLimit: z.coerce.number().int().min(1).max(100_000).optional(),
          gracePeriodDays: z.coerce.number().int().min(0).max(365).optional(),
          primaryContactName: optionalText.optional(),
          primaryContactEmail: z.union([email, z.literal('')]).optional(),
          dataResidency: optionalText.optional(),
          notes: optionalText.optional(),
        })
        .parse(payload);
      const { id: organizationId, ...data } = input;
      const before = await db.organization.findUnique({ where: { id: organizationId } });
      if (!before) throw new PlatformSecurityError('Organization not found.', 400);
      const changesVertical = data.vertical !== undefined && data.vertical !== before.vertical;
      // A vertical correction is deliberately narrower than ordinary onboarding
      // edits: it is an early correction only, before activation or any
      // vertical-owned branch/entitlement rows exist. The replacement package is
      // required in the same command so the organization can never commit a
      // vertical/package mismatch between requests.
      if (changesVertical) {
        if (before.status !== 'ONBOARDING' || before.activatedAt !== null) {
          throw new PlatformSecurityError(
            'The organization vertical can only be corrected during early onboarding.',
            400
          );
        }
        if (data.packageId === undefined || data.packageId === null) {
          throw new PlatformSecurityError(
            'Correct the organization vertical and commercial package together.',
            400
          );
        }
        const [branchCount, moduleOverrideCount] = await Promise.all([
          db.restaurantBranch.count({ where: { organizationId } }),
          db.organizationModule.count({ where: { organizationId } }),
        ]);
        if (branchCount > 0 || moduleOverrideCount > 0) {
          throw new PlatformSecurityError(
            'The organization vertical cannot be corrected after vertical setup has started.',
            400
          );
        }
      }
      // §2.3 — a package (being changed now or already assigned) must match the
      // organization's resulting vertical. Rejected server-side even when a
      // crafted request bypasses the operator UI's filtered choices.
      const nextVertical = data.vertical ?? before.vertical;
      const nextPackageId = data.packageId !== undefined ? data.packageId : before.packageId;
      if (nextPackageId && (data.packageId !== undefined || data.vertical !== undefined)) {
        const nextPackage = await db.platformPackage.findUnique({
          where: { id: nextPackageId },
          select: { active: true, vertical: true },
        });
        if (!nextPackage?.active) {
          throw new PlatformSecurityError('Choose an active commercial package.', 400);
        }
        if (!isPackageCompatibleWithVertical(nextPackage.vertical ?? 'AGENCY', nextVertical)) {
          throw new PlatformSecurityError(
            `The selected package is not available for the ${nextVertical} vertical.`,
            400
          );
        }
      }
      const organization = await db.organization.update({
        where: { id: organizationId },
        data: {
          ...data,
          primaryContactEmail: data.primaryContactEmail === '' ? null : data.primaryContactEmail,
        },
      });
      if (data.deploymentMode && data.deploymentMode !== before.deploymentMode) {
        await db.organizationDeployment.upsert({
          where: {
            organizationId_environment: {
              organizationId,
              environment: 'production',
            },
          },
          update: { mode: data.deploymentMode, status: 'PENDING' },
          create: {
            organizationId,
            environment: 'production',
            mode: data.deploymentMode,
            status: 'PENDING',
          },
        });
        await db.platformJob.create({
          data: {
            organizationId,
            type: data.deploymentMode === 'DEDICATED' ? 'PROVISION_DEDICATED' : 'PROVISION_SHARED',
            requestedById: actor.id,
            payload: { environment: 'production', previousMode: before.deploymentMode },
            idempotencyKey: `deployment-mode:${organizationId}:${Date.now()}`,
          },
        });
      }
      return {
        targetType: 'Organization',
        targetId: organization.id,
        organizationId: organization.id,
        auditBefore: before,
        data: organization,
        audit: organization,
      };
    }
    case 'organization.transition': {
      const input = z
        .object({
          id,
          status: z.enum([
            'PROSPECT',
            'ONBOARDING',
            'ACTIVE',
            'GRACE',
            'SUSPENDED',
            'TERMINATED',
            'PURGING',
            'PURGED',
          ]),
          reason: z.string().trim().min(10).max(500),
        })
        .parse(payload);
      const before = await db.organization.findUnique({ where: { id: input.id } });
      if (!before) throw new PlatformSecurityError('Organization not found.', 400);
      if (!TRANSITIONS[before.status].includes(input.status)) {
        throw new PlatformSecurityError(
          `A ${before.status} organization cannot move directly to ${input.status}.`,
          400
        );
      }
      if (input.status === 'ACTIVE') await assertActivationReady(db, input.id);
      const timestamp = new Date();
      const organization = await db.organization.update({
        where: { id: input.id },
        data: {
          status: input.status,
          ...(input.status === 'ACTIVE'
            ? { activatedAt: before.activatedAt ?? timestamp, suspendedAt: null }
            : {}),
          ...(input.status === 'SUSPENDED' ? { suspendedAt: timestamp } : {}),
          ...(input.status === 'TERMINATED' ? { terminatedAt: timestamp } : {}),
          ...(input.status === 'PURGING'
            ? { purgeScheduledAt: new Date(timestamp.getTime() + 30 * 24 * 60 * 60 * 1000) }
            : {}),
        },
      });
      await db.organizationLifecycleEvent.create({
        data: {
          organizationId: input.id,
          action: lifecycleAction(before.status, input.status),
          fromStatus: before.status,
          toStatus: input.status,
          reason: input.reason,
          actorId: actor.id,
        },
      });
      if (
        input.status === 'SUSPENDED' ||
        (before.status === 'SUSPENDED' && input.status === 'ACTIVE')
      ) {
        const type = input.status === 'SUSPENDED' ? 'SUSPEND' : 'RESUME';
        await db.platformJob.create({
          data: {
            organizationId: input.id,
            type,
            requestedById: actor.id,
            payload: { reason: input.reason },
            idempotencyKey: `${type.toLowerCase()}:${input.id}:${timestamp.toISOString()}`,
          },
        });
      }
      if (input.status === 'PURGING') {
        await db.platformJob.create({
          data: {
            organizationId: input.id,
            type: 'PURGE_DATA',
            requestedById: actor.id,
            scheduledAt: organization.purgeScheduledAt!,
            payload: { reason: input.reason },
            idempotencyKey: `purge:${input.id}:${organization.purgeScheduledAt!.toISOString()}`,
          },
        });
      }
      return {
        targetType: 'Organization',
        targetId: input.id,
        organizationId: input.id,
        auditBefore: { status: before.status },
        data: organization,
        audit: organization,
      };
    }
    case 'organization.module': {
      const input = z
        .object({
          organizationId: id,
          moduleId: id,
          status: z.enum(['ENABLED', 'DISABLED', 'TRIAL', 'EXPIRED']),
          seatLimit: z.coerce.number().int().min(1).max(100_000).nullish(),
          expiresAt: optionalDate.optional(),
          reason: z.string().trim().min(5).max(500),
        })
        .parse(payload);
      // §6 — enablement guard: a module may only be attached to an organization
      // whose vertical owns it. The key → vertical mapping is delegated to the
      // catalog (verticalForModuleKey), so no vertical is branched on inline.
      const [targetOrg, targetModule] = await Promise.all([
        db.organization.findUnique({
          where: { id: input.organizationId },
          select: { vertical: true },
        }),
        db.platformModule.findUnique({
          where: { id: input.moduleId },
          select: { key: true, band: true, vertical: true },
        }),
      ]);
      if (!targetOrg) throw new PlatformSecurityError('Organization not found.', 400);
      if (!targetModule) throw new PlatformSecurityError('Module not found.', 400);
      const targetVertical = targetModule.vertical ?? verticalForModuleKey(targetModule.key);
      if (targetVertical && targetVertical !== targetOrg.vertical) {
        throw new PlatformSecurityError(
          `The ${targetModule.key} module does not belong to the ${targetOrg.vertical} vertical.`,
          400
        );
      }
      const mandatoryKeys = [
        ...mandatoryModulesForVertical(targetOrg.vertical).map((module) => module.key),
        ...(targetModule.band === 'BASELINE' ||
        moduleDefinitionForKey(targetModule.key)?.band === 'BASELINE'
          ? [targetModule.key]
          : []),
      ];
      if (
        mandatoryKeys.includes(targetModule.key) &&
        input.status !== 'ENABLED' &&
        input.status !== 'TRIAL'
      ) {
        throw new PlatformSecurityError(
          `The mandatory ${targetModule.key} module cannot be disabled.`,
          400
        );
      }
      const saved = await db.organizationModule.upsert({
        where: {
          organizationId_moduleId: {
            organizationId: input.organizationId,
            moduleId: input.moduleId,
          },
        },
        update: {
          status: input.status,
          seatLimit: input.seatLimit,
          expiresAt: input.expiresAt,
          reason: input.reason,
          changedById: actor.id,
        },
        create: {
          organizationId: input.organizationId,
          moduleId: input.moduleId,
          status: input.status,
          seatLimit: input.seatLimit,
          expiresAt: input.expiresAt,
          reason: input.reason,
          changedById: actor.id,
        },
      });
      return {
        targetType: 'OrganizationModule',
        targetId: saved.id,
        organizationId: input.organizationId,
        data: saved,
        audit: saved,
      };
    }
    case 'organization.module.reset': {
      const input = z.object({ organizationId: id, moduleId: id }).parse(payload);
      const before = await db.organizationModule.findUnique({
        where: {
          organizationId_moduleId: {
            organizationId: input.organizationId,
            moduleId: input.moduleId,
          },
        },
      });
      if (!before) {
        throw new PlatformSecurityError('The organization has no module override to reset.', 400);
      }
      await db.organizationModule.delete({ where: { id: before.id } });
      return {
        targetType: 'OrganizationModule',
        targetId: before.id,
        organizationId: input.organizationId,
        auditBefore: before,
        data: { inherited: true },
        audit: { inherited: true },
      };
    }
    case 'organization.limit': {
      const input = z
        .object({
          organizationId: id,
          key: z.string().trim().min(2).max(100),
          value: z.coerce.number().int().min(0).max(2_147_483_647),
          period: optionalText.optional(),
          source: z.string().trim().min(2).max(100).default('CONTRACT'),
          expiresAt: optionalDate.optional(),
        })
        .parse(payload);
      const saved = await db.organizationLimit.upsert({
        where: {
          organizationId_key: {
            organizationId: input.organizationId,
            key: input.key,
          },
        },
        update: input,
        create: input,
      });
      return {
        targetType: 'OrganizationLimit',
        targetId: saved.id,
        organizationId: input.organizationId,
        data: saved,
        audit: saved,
      };
    }
    case 'organization.limit.remove': {
      const input = z.object({ id }).parse(payload);
      const before = await db.organizationLimit.findUnique({ where: { id: input.id } });
      if (!before) throw new PlatformSecurityError('Organization limit not found.', 400);
      await db.organizationLimit.delete({ where: { id: before.id } });
      return {
        targetType: 'OrganizationLimit',
        targetId: before.id,
        organizationId: before.organizationId,
        auditBefore: before,
        data: { removed: true },
        audit: { removed: true },
      };
    }
    case 'organization.brand': {
      const input = z
        .object({
          organizationId: id,
          logoUrl: z.url().max(2_000).nullish(),
          markUrl: z.url().max(2_000).nullish(),
          faviconUrl: z.url().max(2_000).nullish(),
          primaryColor: hexColor,
          accentColor: hexColor,
          supportEmail: z.union([email, z.literal('')]).optional(),
          fromName: optionalText.optional(),
        })
        .parse(payload);
      const { organizationId, ...brand } = input;
      const saved = await db.organizationBrand.upsert({
        where: { organizationId },
        update: {
          ...brand,
          supportEmail: brand.supportEmail || null,
          updatedById: actor.id,
        },
        create: {
          organizationId,
          ...brand,
          supportEmail: brand.supportEmail || null,
          updatedById: actor.id,
        },
      });
      await db.platformJob.create({
        data: {
          organizationId,
          type: 'APPLY_BRAND',
          requestedById: actor.id,
          payload: { brandId: saved.id },
        },
      });
      return {
        targetType: 'OrganizationBrand',
        targetId: saved.id,
        organizationId,
        data: saved,
        audit: saved,
      };
    }
    case 'organization.email': {
      const input = z
        .object({
          organizationId: id,
          provider: z.string().trim().min(2).max(80),
          fromName: optionalText.optional(),
          fromAddress: z.union([email, z.literal('')]).optional(),
          replyTo: z.union([email, z.literal('')]).optional(),
          apiKey: z.string().trim().min(8).max(2_000).optional(),
          configuration: z.record(z.string(), z.unknown()).nullish(),
          markVerified: z.boolean().default(false),
        })
        .parse(payload);
      const saved = await db.organizationEmailSettings.upsert({
        where: { organizationId: input.organizationId },
        update: {
          provider: input.provider,
          fromName: input.fromName,
          fromAddress: input.fromAddress || null,
          replyTo: input.replyTo || null,
          encryptedApiKey: input.apiKey ? encryptSecret(input.apiKey) : undefined,
          configuration: input.configuration ? toJson(input.configuration) : undefined,
          domainVerifiedAt: input.markVerified ? new Date() : undefined,
        },
        create: {
          organizationId: input.organizationId,
          provider: input.provider,
          fromName: input.fromName,
          fromAddress: input.fromAddress || null,
          replyTo: input.replyTo || null,
          encryptedApiKey: input.apiKey ? encryptSecret(input.apiKey) : null,
          configuration: input.configuration ? toJson(input.configuration) : undefined,
          domainVerifiedAt: input.markVerified ? new Date() : null,
        },
      });
      // `configuration` is operator-supplied provider config and can carry
      // credentials; `encryptedApiKey` is ciphertext. Neither is auditable.
      const auditable = omit(saved, 'encryptedApiKey', 'configuration');
      return {
        targetType: 'OrganizationEmailSettings',
        targetId: saved.id,
        organizationId: input.organizationId,
        data: { ...saved, encryptedApiKey: saved.encryptedApiKey ? '[REDACTED]' : null },
        audit: { ...auditable, apiKeyConfigured: Boolean(saved.encryptedApiKey) },
      };
    }
    case 'organization.domain': {
      const input = z
        .object({
          organizationId: id,
          host: hostname,
          kind: z.string().trim().min(2).max(30).default('APP'),
          isPrimary: z.boolean().default(false),
        })
        .parse(payload);
      if (input.isPrimary) {
        await db.organizationDomain.updateMany({
          where: { organizationId: input.organizationId },
          data: { isPrimary: false },
        });
      }
      const saved = await db.organizationDomain.create({
        data: {
          ...input,
          verificationToken: randomBytes(24).toString('base64url'),
        },
      });
      await db.platformJob.create({
        data: {
          organizationId: input.organizationId,
          type: 'CONFIGURE_DOMAIN',
          requestedById: actor.id,
          payload: { domainId: saved.id, host: saved.host },
        },
      });
      const auditable = omit(saved, 'verificationToken');
      return {
        targetType: 'OrganizationDomain',
        targetId: saved.id,
        organizationId: input.organizationId,
        data: saved,
        audit: auditable,
      };
    }
    case 'organization.domain.status': {
      const input = z
        .object({
          id,
          status: z.enum(['PENDING', 'VERIFIED', 'FAILED']),
          failureReason: optionalText.optional(),
        })
        .parse(payload);
      const before = await db.organizationDomain.findUnique({ where: { id: input.id } });
      if (!before) throw new PlatformSecurityError('Domain not found.', 400);
      const saved = await db.organizationDomain.update({
        where: { id: input.id },
        data: {
          verificationStatus: input.status,
          verifiedAt: input.status === 'VERIFIED' ? new Date() : null,
          lastCheckedAt: new Date(),
          failureReason: input.status === 'FAILED' ? input.failureReason : null,
        },
      });
      const auditable = omit(saved, 'verificationToken');
      const auditableBefore = omit(before, 'verificationToken');
      return {
        targetType: 'OrganizationDomain',
        targetId: saved.id,
        organizationId: saved.organizationId,
        auditBefore: auditableBefore,
        data: saved,
        audit: auditable,
      };
    }
    case 'organization.domain.retry': {
      const input = z.object({ id }).parse(payload);
      const domain = await db.organizationDomain.findUnique({ where: { id: input.id } });
      if (!domain) throw new PlatformSecurityError('Domain not found.', 400);
      await db.organizationDomain.update({
        where: { id: domain.id },
        data: { verificationStatus: 'PENDING', failureReason: null },
      });
      const saved = await db.platformJob.create({
        data: {
          organizationId: domain.organizationId,
          type: 'CONFIGURE_DOMAIN',
          requestedById: actor.id,
          payload: { domainId: domain.id, host: domain.host },
        },
      });
      return {
        targetType: 'PlatformJob',
        targetId: saved.id,
        organizationId: domain.organizationId,
        data: saved,
        audit: saved,
      };
    }
    case 'organization.domain.remove': {
      const input = z.object({ id, reason: z.string().trim().min(5).max(500) }).parse(payload);
      const before = await db.organizationDomain.findUnique({ where: { id: input.id } });
      if (!before) throw new PlatformSecurityError('Domain not found.', 400);
      if (before.isPrimary) {
        throw new PlatformSecurityError('Choose another primary domain before removal.', 400);
      }
      await db.organizationDomain.delete({ where: { id: input.id } });
      const auditableBefore = omit(before, 'verificationToken');
      return {
        targetType: 'OrganizationDomain',
        targetId: before.id,
        organizationId: before.organizationId,
        auditBefore: auditableBefore,
        data: { removed: true, reason: input.reason },
        audit: { removed: true, reason: input.reason },
      };
    }
    case 'organization.identity': {
      const input = z
        .object({
          id: optionalId.optional(),
          organizationId: id,
          name: requiredText,
          protocol: z.enum(['OIDC', 'SAML']),
          status: z.enum(['DRAFT', 'ACTIVE', 'DISABLED', 'ERROR']).default('DRAFT'),
          issuer: optionalText.optional(),
          clientId: optionalText.optional(),
          clientSecret: z.string().trim().min(8).max(2_000).optional(),
          discoveryUrl: z.url().max(2_000).nullish(),
          ssoUrl: z.url().max(2_000).nullish(),
          entityId: optionalText.optional(),
          certificate: optionalText.optional(),
          domains: z.array(hostname).max(25).default([]),
          allowJit: z.boolean().default(true),
          enforceSso: z.boolean().default(false),
          roleMappings: z.record(z.string(), z.string()).nullish(),
          configuration: z.record(z.string(), z.unknown()).nullish(),
        })
        .refine((value) => !value.enforceSso || value.status === 'ACTIVE', {
          message: 'SSO can only be enforced after the connection is active.',
        })
        .parse(payload);
      const { id: connectionId, clientSecret, roleMappings, configuration, ...connection } = input;
      const data = {
        ...connection,
        encryptedClientSecret: clientSecret ? encryptSecret(clientSecret) : undefined,
        roleMappings: roleMappings ? toJson(roleMappings) : undefined,
        configuration: configuration ? toJson(configuration) : undefined,
      };
      const before = connectionId
        ? await db.organizationIdentityConnection.findUnique({ where: { id: connectionId } })
        : null;
      const saved = connectionId
        ? await db.organizationIdentityConnection.update({
            where: { id: connectionId },
            data,
          })
        : await db.organizationIdentityConnection.create({ data });
      return {
        targetType: 'OrganizationIdentityConnection',
        targetId: saved.id,
        organizationId: input.organizationId,
        auditBefore: before ? identityConnectionAudit(before) : undefined,
        data: {
          ...saved,
          encryptedClientSecret: saved.encryptedClientSecret ? '[REDACTED]' : null,
        },
        audit: identityConnectionAudit(saved),
      };
    }
    case 'organization.identity.test': {
      const input = z.object({ id }).parse(payload);
      const connection = await db.organizationIdentityConnection.findUnique({
        where: { id: input.id },
      });
      if (!connection) throw new PlatformSecurityError('Identity connection not found.', 400);
      const job = await db.platformJob.create({
        data: {
          organizationId: connection.organizationId,
          type: 'SYNC_IDENTITY',
          requestedById: actor.id,
          payload: { connectionId: connection.id, operation: 'TEST' },
        },
      });
      await db.organizationIdentityConnection.update({
        where: { id: connection.id },
        data: { lastError: null },
      });
      return {
        targetType: 'PlatformJob',
        targetId: job.id,
        organizationId: connection.organizationId,
        data: job,
        audit: jobAudit(job),
      };
    }
    case 'organization.identity.remove': {
      const input = z.object({ id, reason: z.string().trim().min(5).max(500) }).parse(payload);
      const before = await db.organizationIdentityConnection.findUnique({
        where: { id: input.id },
      });
      if (!before) throw new PlatformSecurityError('Identity connection not found.', 400);
      await db.organizationIdentityConnection.delete({ where: { id: input.id } });
      return {
        targetType: 'OrganizationIdentityConnection',
        targetId: before.id,
        organizationId: before.organizationId,
        auditBefore: identityConnectionAudit(before),
        data: { removed: true, reason: input.reason },
        audit: { removed: true, reason: input.reason },
      };
    }
    case 'organization.scim.token': {
      const input = z
        .object({
          organizationId: id,
          name: requiredText,
          expiresAt: optionalDate.optional(),
        })
        .parse(payload);
      const token = `scim_${randomBytes(32).toString('base64url')}`;
      const saved = await db.organizationScimToken.create({
        data: {
          organizationId: input.organizationId,
          name: input.name,
          prefix: token.slice(0, 16),
          tokenHash: createHash('sha256').update(token).digest('hex'),
          expiresAt: input.expiresAt,
        },
      });
      const credential = omit(saved, 'tokenHash');
      return {
        targetType: 'OrganizationScimToken',
        targetId: saved.id,
        organizationId: input.organizationId,
        // REVEAL: the operator copies the bearer token here, once. This object
        // is returned by the HTTP command and is never audited.
        data: { ...credential, token },
        // AUDIT: identity of the credential, never the credential. `prefix` is
        // the non-secret handle the console already shows for this token.
        audit: credential,
      };
    }
    case 'organization.scim.revoke': {
      const input = z.object({ id }).parse(payload);
      const saved = await db.organizationScimToken.update({
        where: { id: input.id },
        data: { revokedAt: new Date() },
      });
      return {
        targetType: 'OrganizationScimToken',
        targetId: saved.id,
        organizationId: saved.organizationId,
        data: { ...saved, tokenHash: undefined },
        audit: { ...saved, tokenHash: undefined },
      };
    }
    case 'organization.role': {
      const input = z
        .object({
          id: optionalId.optional(),
          organizationId: id,
          key: z
            .string()
            .trim()
            .min(2)
            .max(80)
            .regex(/^[a-z0-9._-]+$/),
          name: requiredText,
          description: optionalText.optional(),
          permissions: z
            .array(
              z.object({
                capability: z.string().trim().min(1).max(150),
                effect: z.enum(['ALLOW', 'DENY']),
              })
            )
            .max(250)
            .default([]),
        })
        .parse(payload);
      const { id: roleId, permissions, ...role } = input;
      const existing = roleId
        ? await db.organizationRole.findUnique({ where: { id: roleId } })
        : null;
      if (existing?.isSystem) {
        throw new PlatformSecurityError('System roles cannot be modified.', 400);
      }
      const saved = roleId
        ? await db.organizationRole.update({ where: { id: roleId }, data: role })
        : await db.organizationRole.create({ data: role });
      await db.organizationRolePermission.deleteMany({
        where: { organizationRoleId: saved.id },
      });
      if (permissions.length) {
        await db.organizationRolePermission.createMany({
          data: permissions.map((permission) => ({
            organizationId: input.organizationId,
            organizationRoleId: saved.id,
            ...permission,
          })),
        });
      }
      return {
        targetType: 'OrganizationRole',
        targetId: saved.id,
        organizationId: input.organizationId,
        data: { ...saved, permissions },
        audit: { ...saved, permissions },
      };
    }
    case 'organization.role.remove': {
      const input = z.object({ id }).parse(payload);
      const before = await db.organizationRole.findUnique({
        where: { id: input.id },
        include: { _count: { select: { users: true } } },
      });
      if (!before) throw new PlatformSecurityError('Organization role not found.', 400);
      if (before.isSystem) {
        throw new PlatformSecurityError('System roles cannot be removed.', 400);
      }
      if (before._count.users > 0) {
        throw new PlatformSecurityError(
          `Reassign ${before._count.users} user(s) before removing this role.`,
          400
        );
      }
      await db.organizationRole.delete({ where: { id: before.id } });
      return {
        targetType: 'OrganizationRole',
        targetId: before.id,
        organizationId: before.organizationId,
        auditBefore: before,
        data: { removed: true },
        audit: { removed: true },
      };
    }
    case 'organization.permission': {
      const input = z
        .object({
          organizationId: id,
          userId: id,
          capability: z.string().trim().min(1).max(150),
          effect: z.enum(['ALLOW', 'DENY']),
          reason: z.string().trim().min(5).max(500),
          expiresAt: optionalDate.optional(),
        })
        .parse(payload);
      const saved = await db.userPermissionOverride.upsert({
        where: {
          userId_capability: {
            userId: input.userId,
            capability: input.capability,
          },
        },
        update: { ...input, createdById: actor.id },
        create: { ...input, createdById: actor.id },
      });
      return {
        targetType: 'UserPermissionOverride',
        targetId: saved.id,
        organizationId: input.organizationId,
        data: saved,
        audit: saved,
      };
    }
    case 'organization.permission.remove': {
      const input = z.object({ id }).parse(payload);
      const before = await db.userPermissionOverride.findUnique({ where: { id: input.id } });
      if (!before) throw new PlatformSecurityError('Permission override not found.', 400);
      await db.userPermissionOverride.delete({ where: { id: before.id } });
      return {
        targetType: 'UserPermissionOverride',
        targetId: before.id,
        organizationId: before.organizationId,
        auditBefore: before,
        data: { removed: true },
        audit: { removed: true },
      };
    }
    case 'organization.user': {
      const input = z
        .object({
          id,
          organizationRoleId: optionalId.optional(),
          role: z.enum(['ADMIN', 'EMPLOYEE', 'HR']).optional(),
          status: z.enum(['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'INVITED']).optional(),
          title: requiredText.optional(),
          department: z
            .enum(['LEADERSHIP', 'ENGINEERING', 'PRODUCT', 'QUALITY', 'MARKETING', 'DESIGN'])
            .optional(),
        })
        .parse(payload);
      const { id: userId, ...data } = input;
      const before = await db.user.findUnique({ where: { id: userId } });
      if (!before) throw new PlatformSecurityError('Organization user not found.', 400);
      const auditableBefore = omit(before, 'password', 'twoFactorSecret');
      const saved = await db.user.update({
        where: { id: userId },
        data: {
          ...data,
          tokenVersion:
            data.status && !['ACTIVE', 'ON_LEAVE'].includes(data.status)
              ? { increment: 1 }
              : undefined,
        },
      });
      return {
        targetType: 'User',
        targetId: saved.id,
        organizationId: saved.organizationId,
        auditBefore: auditableBefore,
        data: { ...saved, password: undefined, twoFactorSecret: undefined },
        audit: { ...saved, password: undefined, twoFactorSecret: undefined },
      };
    }
    case 'organization.user.password': {
      const input = z.object({ id, password: z.string().min(12).max(256) }).parse(payload);
      const password = await hash(input.password, 12);
      const saved = await db.user.update({
        where: { id: input.id },
        data: {
          password,
          passwordChangedAt: new Date(),
          tokenVersion: { increment: 1 },
        },
      });
      return {
        targetType: 'User',
        targetId: saved.id,
        organizationId: saved.organizationId,
        data: { id: saved.id, passwordReset: true },
        audit: { id: saved.id, passwordReset: true },
      };
    }
    case 'organization.usage': {
      const input = z
        .object({
          organizationId: id,
          key: z.string().trim().min(2).max(100),
          periodStart: date,
          periodEnd: date,
          value: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        })
        .refine((value) => value.periodEnd > value.periodStart, {
          message: 'Usage period end must follow its start.',
        })
        .parse(payload);
      const saved = await db.organizationUsageCounter.upsert({
        where: {
          organizationId_key_periodStart_periodEnd: {
            organizationId: input.organizationId,
            key: input.key,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
          },
        },
        update: { value: BigInt(input.value) },
        create: { ...input, value: BigInt(input.value) },
      });
      return {
        targetType: 'OrganizationUsageCounter',
        targetId: saved.id,
        organizationId: input.organizationId,
        data: { ...saved, value: saved.value.toString() },
        audit: { ...saved, value: saved.value.toString() },
      };
    }
    case 'crm.account.create': {
      const input = z
        .object({
          name: requiredText,
          legalName: optionalText.optional(),
          website: z.url().max(2_000).nullish(),
          industry: optionalText.optional(),
          country: optionalText.optional(),
          source: optionalText.optional(),
          notes: optionalText.optional(),
        })
        .parse(payload);
      const saved = await db.platformAccount.create({ data: { ...input, ownerId: actor.id } });
      return { targetType: 'PlatformAccount', targetId: saved.id, data: saved, audit: saved };
    }
    case 'crm.lead.create': {
      const input = z
        .object({
          accountId: optionalId.optional(),
          name: requiredText,
          email: z.union([email, z.literal('')]).optional(),
          phone: optionalText.optional(),
          companyName: optionalText.optional(),
          source: optionalText.optional(),
          notes: optionalText.optional(),
        })
        .parse(payload);
      const saved = await db.platformLead.create({
        data: { ...input, email: input.email || null, ownerId: actor.id },
      });
      return { targetType: 'PlatformLead', targetId: saved.id, data: saved, audit: saved };
    }
    case 'crm.lead.status': {
      const input = z
        .object({
          id,
          status: z.enum(['NEW', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED']),
          notes: optionalText.optional(),
        })
        .parse(payload);
      const before = await db.platformLead.findUnique({ where: { id: input.id } });
      if (!before) throw new PlatformSecurityError('Lead not found.', 400);
      const saved = await db.platformLead.update({
        where: { id: input.id },
        data: {
          status: input.status,
          notes: input.notes ?? undefined,
          convertedAt: input.status === 'CONVERTED' ? new Date() : null,
        },
      });
      return {
        targetType: 'PlatformLead',
        targetId: saved.id,
        auditBefore: before,
        data: saved,
        audit: saved,
      };
    }
    case 'crm.contact.create': {
      const input = z
        .object({
          accountId: id,
          name: requiredText,
          email: z.union([email, z.literal('')]).optional(),
          phone: optionalText.optional(),
          title: optionalText.optional(),
          isPrimary: z.boolean().default(false),
        })
        .parse(payload);
      if (input.isPrimary) {
        await db.platformContact.updateMany({
          where: { accountId: input.accountId },
          data: { isPrimary: false },
        });
      }
      const saved = await db.platformContact.create({
        data: { ...input, email: input.email || null },
      });
      return { targetType: 'PlatformContact', targetId: saved.id, data: saved, audit: saved };
    }
    case 'crm.opportunity.create': {
      const input = z
        .object({
          accountId: id,
          name: requiredText,
          stage: z
            .enum(['DISCOVERY', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'])
            .default('DISCOVERY'),
          estimatedValue: money.nullish(),
          currency: currency.default('USD'),
          probability: z.coerce.number().int().min(0).max(100).default(10),
          expectedCloseAt: optionalDate.optional(),
          notes: optionalText.optional(),
        })
        .parse(payload);
      const saved = await db.platformOpportunity.create({
        data: { ...input, ownerId: actor.id },
      });
      await db.platformOpportunityStageEvent.create({
        data: {
          opportunityId: saved.id,
          toStage: saved.stage,
          changedById: actor.id,
          reason: 'Opportunity created',
        },
      });
      return { targetType: 'PlatformOpportunity', targetId: saved.id, data: saved, audit: saved };
    }
    case 'crm.opportunity.stage': {
      const input = z
        .object({
          id,
          stage: z.enum(['DISCOVERY', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST']),
          probability: z.coerce.number().int().min(0).max(100).optional(),
          reason: z.string().trim().min(5).max(500),
          lossReason: optionalText.optional(),
        })
        .parse(payload);
      const before = await db.platformOpportunity.findUnique({ where: { id: input.id } });
      if (!before) throw new PlatformSecurityError('Opportunity not found.', 400);
      const saved = await db.platformOpportunity.update({
        where: { id: input.id },
        data: {
          stage: input.stage,
          probability: input.probability,
          lossReason: input.stage === 'LOST' ? input.lossReason : null,
          wonAt: input.stage === 'WON' ? new Date() : null,
          lostAt: input.stage === 'LOST' ? new Date() : null,
        },
      });
      await db.platformOpportunityStageEvent.create({
        data: {
          opportunityId: input.id,
          fromStage: before.stage,
          toStage: input.stage,
          changedById: actor.id,
          reason: input.reason,
        },
      });
      return {
        targetType: 'PlatformOpportunity',
        targetId: saved.id,
        auditBefore: before,
        data: saved,
        audit: saved,
      };
    }
    case 'crm.opportunity.convert': {
      const input = organizationInput.parse(payload);
      if (!input.opportunityId) {
        throw new PlatformSecurityError('An opportunity is required for conversion.', 400);
      }
      const organization = await bootstrapOrganization(db, actor, input);
      return {
        targetType: 'Organization',
        targetId: organization.id,
        organizationId: organization.id,
        data: organization,
        audit: organization,
      };
    }
    case 'crm.proposal.create': {
      const input = z
        .object({
          opportunityId: id,
          number: z.string().trim().min(3).max(100),
          title: requiredText,
          currency: currency.default('USD'),
          total: money,
          validUntil: optionalDate.optional(),
          lineItems: z
            .array(
              z.object({
                description: requiredText,
                quantity: z.coerce.number().positive().max(1_000_000),
                unitPrice: money,
              })
            )
            .min(1)
            .max(100),
        })
        .parse(payload);
      const saved = await db.platformProposal.create({
        data: { ...input, lineItems: toJson(input.lineItems), createdById: actor.id },
      });
      return { targetType: 'PlatformProposal', targetId: saved.id, data: saved, audit: saved };
    }
    case 'crm.proposal.status': {
      const input = z
        .object({
          id,
          status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED']),
        })
        .parse(payload);
      const before = await db.platformProposal.findUnique({ where: { id: input.id } });
      if (!before) throw new PlatformSecurityError('Proposal not found.', 400);
      const saved = await db.platformProposal.update({
        where: { id: input.id },
        data: {
          status: input.status,
          sentAt: input.status === 'SENT' ? new Date() : before.sentAt,
          acceptedAt: input.status === 'ACCEPTED' ? new Date() : null,
        },
      });
      return {
        targetType: 'PlatformProposal',
        targetId: saved.id,
        auditBefore: before,
        data: saved,
        audit: saved,
      };
    }
    case 'crm.followup.create': {
      const input = z
        .object({
          accountId: optionalId.optional(),
          leadId: optionalId.optional(),
          opportunityId: optionalId.optional(),
          title: requiredText,
          notes: optionalText.optional(),
          dueAt: date,
        })
        .refine((value) => value.accountId || value.leadId || value.opportunityId, {
          message: 'A follow-up must be attached to a sales record.',
        })
        .parse(payload);
      const saved = await db.platformFollowUp.create({
        data: { ...input, ownerId: actor.id },
      });
      return { targetType: 'PlatformFollowUp', targetId: saved.id, data: saved, audit: saved };
    }
    case 'crm.followup.status': {
      const input = z
        .object({
          id,
          status: z.enum(['OPEN', 'COMPLETED', 'CANCELLED']),
        })
        .parse(payload);
      const before = await db.platformFollowUp.findUnique({ where: { id: input.id } });
      if (!before) throw new PlatformSecurityError('Follow-up not found.', 400);
      const saved = await db.platformFollowUp.update({
        where: { id: input.id },
        data: {
          status: input.status,
          completedAt: input.status === 'COMPLETED' ? new Date() : null,
        },
      });
      return {
        targetType: 'PlatformFollowUp',
        targetId: saved.id,
        auditBefore: before,
        data: saved,
        audit: saved,
      };
    }
    case 'commercial.contract.create': {
      const input = z
        .object({
          organizationId: id,
          opportunityId: optionalId.optional(),
          number: z.string().trim().min(3).max(100),
          title: requiredText,
          status: z.enum(['DRAFT', 'ACTIVE', 'GRACE', 'EXPIRED', 'TERMINATED', 'RENEWAL_DUE']),
          currency: currency.default('USD'),
          value: money,
          billingInterval: z.enum(['MONTHLY', 'QUARTERLY', 'ANNUAL', 'CUSTOM']),
          seatLimit: z.coerce.number().int().min(1).max(100_000),
          startDate: date,
          endDate: date,
          graceUntil: optionalDate.optional(),
          autoRenew: z.boolean().default(false),
          notes: optionalText.optional(),
          moduleIds: z.array(id).max(100).default([]),
        })
        .refine((value) => value.endDate > value.startDate, {
          message: 'Contract end date must follow the start date.',
        })
        .parse(payload);
      const { moduleIds, ...contract } = input;
      const saved = await db.platformContract.create({
        data: {
          ...contract,
          ownerId: actor.id,
          signedAt: input.status === 'ACTIVE' ? new Date() : null,
          modules: { create: moduleIds.map((moduleId) => ({ moduleId })) },
        },
      });
      await syncContractEntitlements(db, actor, {
        ...input,
        graceUntil: input.graceUntil ?? null,
        moduleIds,
      });
      return {
        targetType: 'PlatformContract',
        targetId: saved.id,
        organizationId: input.organizationId,
        data: saved,
        audit: saved,
      };
    }
    case 'commercial.contract.status': {
      const input = z
        .object({
          id,
          status: z.enum(['DRAFT', 'ACTIVE', 'GRACE', 'EXPIRED', 'TERMINATED', 'RENEWAL_DUE']),
          reason: z.string().trim().min(5).max(500),
        })
        .parse(payload);
      const before = await db.platformContract.findUnique({
        where: { id: input.id },
        include: { modules: { select: { moduleId: true } } },
      });
      if (!before) throw new PlatformSecurityError('Contract not found.', 400);
      const saved = await db.platformContract.update({
        where: { id: input.id },
        data: {
          status: input.status,
          signedAt: input.status === 'ACTIVE' ? (before.signedAt ?? new Date()) : before.signedAt,
          notes: [before.notes, `Status ${input.status}: ${input.reason}`]
            .filter(Boolean)
            .join('\n'),
        },
      });
      await syncContractEntitlements(db, actor, {
        organizationId: before.organizationId,
        number: before.number,
        status: input.status,
        seatLimit: before.seatLimit,
        endDate: before.endDate,
        graceUntil: before.graceUntil,
        moduleIds: before.modules.map((module) => module.moduleId),
      });
      if (['EXPIRED', 'TERMINATED'].includes(input.status)) {
        await db.organizationModule.updateMany({
          where: {
            organizationId: before.organizationId,
            reason: `Contract ${before.number}`,
          },
          data: {
            status: 'EXPIRED',
            changedById: actor.id,
            reason: `Contract ${before.number} ${input.status.toLowerCase()}`,
          },
        });
      }
      return {
        targetType: 'PlatformContract',
        targetId: saved.id,
        organizationId: saved.organizationId,
        auditBefore: before,
        data: saved,
        audit: saved,
      };
    }
    case 'commercial.invoice.create': {
      const input = z
        .object({
          organizationId: id,
          contractId: optionalId.optional(),
          number: z.string().trim().min(3).max(100),
          currency: currency.default('USD'),
          subtotal: money,
          tax: money.default(0),
          dueAt: date,
          notes: optionalText.optional(),
          lineItems: z
            .array(
              z.object({
                description: requiredText,
                quantity: z.coerce.number().positive().max(1_000_000),
                unitPrice: money,
              })
            )
            .min(1)
            .max(100),
          issueNow: z.boolean().default(false),
        })
        .parse(payload);
      const { issueNow, ...invoice } = input;
      const saved = await db.platformInvoice.create({
        data: {
          ...invoice,
          lineItems: toJson(input.lineItems),
          total: input.subtotal + input.tax,
          status: issueNow ? 'ISSUED' : 'DRAFT',
          issuedAt: issueNow ? new Date() : null,
        },
      });
      return {
        targetType: 'PlatformInvoice',
        targetId: saved.id,
        organizationId: input.organizationId,
        data: saved,
        audit: saved,
      };
    }
    case 'commercial.invoice.status': {
      const input = z
        .object({
          id,
          status: z.enum(['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID']),
          reason: z.string().trim().min(5).max(500),
        })
        .parse(payload);
      const before = await db.platformInvoice.findUnique({ where: { id: input.id } });
      if (!before) throw new PlatformSecurityError('Invoice not found.', 400);
      const saved = await db.platformInvoice.update({
        where: { id: input.id },
        data: {
          status: input.status,
          issuedAt: input.status === 'ISSUED' ? (before.issuedAt ?? new Date()) : before.issuedAt,
          paidAt:
            input.status === 'PAID' ? new Date() : input.status === 'VOID' ? null : before.paidAt,
          notes: [before.notes, `Status ${input.status}: ${input.reason}`]
            .filter(Boolean)
            .join('\n'),
        },
      });
      return {
        targetType: 'PlatformInvoice',
        targetId: saved.id,
        organizationId: saved.organizationId,
        auditBefore: before,
        data: saved,
        audit: saved,
      };
    }
    case 'commercial.payment.record': {
      const input = z
        .object({
          invoiceId: id,
          amount: money,
          currency: currency.default('USD'),
          method: requiredText,
          externalRef: optionalText.optional(),
          idempotencyKey: z.string().trim().min(8).max(200),
          status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED']).default('SUCCEEDED'),
          failureReason: optionalText.optional(),
        })
        .parse(payload);
      const invoice = await db.platformInvoice.findUnique({
        where: { id: input.invoiceId },
        select: { id: true, organizationId: true, total: true },
      });
      if (!invoice) throw new PlatformSecurityError('Invoice not found.', 400);
      const saved = await db.platformPayment.create({
        data: {
          ...input,
          organizationId: invoice.organizationId,
          paidAt: input.status === 'SUCCEEDED' ? new Date() : null,
        },
      });
      const paid = await db.platformPayment.aggregate({
        where: { invoiceId: invoice.id, status: 'SUCCEEDED' },
        _sum: { amount: true },
      });
      const paidAmount = Number(paid._sum.amount ?? 0);
      await db.platformInvoice.update({
        where: { id: invoice.id },
        data: {
          status: paidAmount >= Number(invoice.total) ? 'PAID' : 'PARTIALLY_PAID',
          paidAt: paidAmount >= Number(invoice.total) ? new Date() : null,
        },
      });
      return {
        targetType: 'PlatformPayment',
        targetId: saved.id,
        organizationId: invoice.organizationId,
        data: saved,
        audit: saved,
      };
    }
    case 'commercial.renewal.create': {
      const input = z
        .object({
          organizationId: id,
          contractId: id,
          dueAt: date,
          proposedValue: money.nullish(),
          proposedSeats: z.coerce.number().int().min(1).max(100_000).nullish(),
          notes: optionalText.optional(),
        })
        .parse(payload);
      const saved = await db.platformRenewal.create({
        data: { ...input, ownerId: actor.id },
      });
      return {
        targetType: 'PlatformRenewal',
        targetId: saved.id,
        organizationId: input.organizationId,
        data: saved,
        audit: saved,
      };
    }
    case 'commercial.renewal.status': {
      const input = z
        .object({
          id,
          status: z.enum(['UPCOMING', 'IN_PROGRESS', 'RENEWED', 'LOST']),
          notes: optionalText.optional(),
        })
        .parse(payload);
      const before = await db.platformRenewal.findUnique({ where: { id: input.id } });
      if (!before) throw new PlatformSecurityError('Renewal not found.', 400);
      const saved = await db.platformRenewal.update({
        where: { id: input.id },
        data: {
          status: input.status,
          notes: input.notes ?? before.notes,
          completedAt: ['RENEWED', 'LOST'].includes(input.status) ? new Date() : null,
        },
      });
      return {
        targetType: 'PlatformRenewal',
        targetId: saved.id,
        organizationId: saved.organizationId,
        auditBefore: before,
        data: saved,
        audit: saved,
      };
    }
    case 'catalog.module.upsert': {
      const input = z
        .object({
          id: optionalId.optional(),
          key: z
            .string()
            .trim()
            .min(2)
            .max(80)
            .regex(/^[a-z0-9._-]+$/),
          name: requiredText,
          description: optionalText.optional(),
          category: z.string().trim().min(2).max(80),
          band: z.enum(['BASELINE', 'PLATFORM', 'VERTICAL_CORE', 'VERTICAL_OPTIONAL']),
          vertical: vertical.nullish(),
          routePrefix: z.string().trim().max(200).nullish(),
          icon: z.string().trim().max(80).nullish(),
          active: z.boolean().default(true),
          sortOrder: z.coerce.number().int().min(0).max(10_000).default(0),
        })
        .superRefine((value, ctx) => {
          const verticalBand = value.band === 'VERTICAL_CORE' || value.band === 'VERTICAL_OPTIONAL';
          if (verticalBand !== Boolean(value.vertical)) {
            ctx.addIssue({
              code: 'custom',
              message: 'Vertical bands require a vertical; baseline and platform bands forbid one.',
              path: ['vertical'],
            });
          }
        })
        .parse(payload);
      const { id: moduleId, ...data } = input;
      const saved = moduleId
        ? await db.platformModule.update({ where: { id: moduleId }, data })
        : await db.platformModule.create({ data });
      return { targetType: 'PlatformModule', targetId: saved.id, data: saved, audit: saved };
    }
    // CAM-L1 — one contiguous block. Platform RLS is privileged here, so every
    // tenant write verifies branch ownership and writes organizationId itself.
    case 'organization.camera.register': {
      const input = z
        .object({
          organizationId: id,
          branchId: id,
          gatewayId: id,
          name: requiredText,
          sourceRef: requiredText,
          credentialCiphertext: z.string().min(16).max(20_000),
          assembledRtspUrl: z.string().url().max(2_000),
        })
        .strict()
        .parse(payload);
      const branch = await db.restaurantBranch.findFirst({
        where: { id: input.branchId, organizationId: input.organizationId },
        select: { id: true },
      });
      if (!branch) throw new PlatformSecurityError('Branch does not belong to organization.', 400);
      const gateway = await db.restaurantCameraGateway.findFirst({
        where: {
          id: input.gatewayId,
          branchId: input.branchId,
          organizationId: input.organizationId,
          status: 'ACTIVE',
          revokedAt: null,
        },
        select: { id: true },
      });
      if (!gateway) throw new PlatformSecurityError('Active camera gateway not found.', 400);
      const credential = await db.restaurantCameraCredential.create({
        data: { organizationId: input.organizationId, sealedValue: input.credentialCiphertext },
      });
      const saved = await db.restaurantCamera.create({
        data: {
          organizationId: input.organizationId,
          branchId: input.branchId,
          gatewayId: gateway.id,
          credentialId: credential.id,
          name: input.name,
          sourceRef: input.sourceRef,
        },
      });
      return {
        targetType: 'RestaurantCamera',
        targetId: saved.id,
        organizationId: input.organizationId,
        data: saved,
        audit: omit(input, 'credentialCiphertext', 'assembledRtspUrl'),
      };
    }
    case 'organization.camera.update': {
      const input = z
        .object({
          id,
          organizationId: id,
          branchId: id,
          name: requiredText.optional(),
          sourceRef: requiredText.optional(),
          enabled: z.boolean().optional(),
          credentialCiphertext: z.string().min(16).max(20_000).optional(),
          assembledRtspUrl: z.string().url().max(2_000).optional(),
        })
        .strict()
        .parse(payload);
      const branch = await db.restaurantBranch.findFirst({
        where: { id: input.branchId, organizationId: input.organizationId },
        select: { id: true },
      });
      if (!branch) throw new PlatformSecurityError('Branch does not belong to organization.', 400);
      const before = await db.restaurantCamera.findFirst({
        where: { id: input.id, branchId: input.branchId, organizationId: input.organizationId },
      });
      if (!before) throw new PlatformSecurityError('Camera not found.', 400);
      if (input.credentialCiphertext) {
        await db.restaurantCameraCredential.update({
          where: { id: before.credentialId },
          data: {
            sealedValue: input.credentialCiphertext,
            version: { increment: 1 },
            rotatedAt: new Date(),
          },
        });
      }
      const saved = await db.restaurantCamera.update({
        where: { id: before.id },
        data: { name: input.name, sourceRef: input.sourceRef, enabled: input.enabled },
      });
      const safeAudit = omit(input, 'credentialCiphertext', 'assembledRtspUrl');
      return {
        targetType: 'RestaurantCamera',
        targetId: saved.id,
        organizationId: input.organizationId,
        auditBefore: before,
        data: saved,
        audit: safeAudit,
      };
    }
    case 'organization.camera.remove': {
      const input = z.object({ id, organizationId: id }).strict().parse(payload);
      const before = await db.restaurantCamera.findFirst({
        where: { id: input.id, organizationId: input.organizationId },
      });
      if (!before) throw new PlatformSecurityError('Camera not found.', 400);
      await db.restaurantCamera.delete({ where: { id: before.id } });
      return {
        targetType: 'RestaurantCamera',
        targetId: before.id,
        organizationId: input.organizationId,
        auditBefore: before,
        data: { removed: true },
        audit: { removed: true },
      };
    }
    case 'catalog.camerapreset': {
      const input = z
        .object({
          id: optionalId.optional(),
          key: z
            .string()
            .trim()
            .min(2)
            .max(80)
            .regex(/^[a-z0-9-]+$/),
          familyName: requiredText,
          aliases: z.array(requiredText).max(20),
          iconKey: requiredText,
          rtspPort: z.coerce.number().int().min(1).max(65_535),
          onvifPort: z.coerce.number().int().min(1).max(65_535),
          mainStreamPathTemplate: requiredText,
          subStreamPathTemplate: requiredText,
          authSchemeHint: requiredText,
          defaultUsernameHint: optionalText.optional(),
          credentialNote: requiredText,
          setupNote: requiredText,
          active: z.boolean(),
          sortOrder: z.coerce.number().int().min(0).max(10_000),
        })
        .strict()
        .parse(payload);
      const { id: presetId, ...data } = input;
      const saved = presetId
        ? await db.platformCameraBrandPreset.update({ where: { id: presetId }, data })
        : await db.platformCameraBrandPreset.create({ data });
      return {
        targetType: 'PlatformCameraBrandPreset',
        targetId: saved.id,
        data: saved,
        audit: saved,
      };
    }
    case 'catalog.camerapreset.remove': {
      const input = z.object({ id }).strict().parse(payload);
      const before = await db.platformCameraBrandPreset.findUnique({ where: { id: input.id } });
      if (!before) throw new PlatformSecurityError('Camera preset not found.', 400);
      await db.platformCameraBrandPreset.delete({ where: { id: before.id } });
      return {
        targetType: 'PlatformCameraBrandPreset',
        targetId: before.id,
        auditBefore: before,
        data: { removed: true },
        audit: { removed: true },
      };
    }
    case 'catalog.package.upsert': {
      const input = z
        .object({
          id: optionalId.optional(),
          key: z
            .string()
            .trim()
            .min(2)
            .max(80)
            .regex(/^[a-z0-9._-]+$/),
          name: requiredText,
          description: optionalText.optional(),
          active: z.boolean().default(true),
          // §2.3 — package vertical metadata. Left optional (no default) so an
          // omitted value keeps the column's existing value on update and falls
          // back to the schema default (AGENCY) on create.
          vertical: vertical.optional(),
          defaultSeats: z.coerce.number().int().min(1).max(100_000),
        })
        .parse(payload);
      const { id: packageId, ...data } = input;
      const saved = packageId
        ? await db.platformPackage.update({
            where: { id: packageId },
            data: { ...data, version: { increment: 1 } },
          })
        : await db.platformPackage.create({ data });
      return { targetType: 'PlatformPackage', targetId: saved.id, data: saved, audit: saved };
    }
    case 'catalog.package.module': {
      const input = z
        .object({
          packageId: id,
          moduleId: id,
          enabled: z.boolean(),
          limits: z.record(z.string(), z.number().int().min(0)).nullish(),
        })
        .parse(payload);
      const [targetPackage, targetModule] = await Promise.all([
        db.platformPackage.findUnique({
          where: { id: input.packageId },
          select: { vertical: true },
        }),
        db.platformModule.findUnique({
          where: { id: input.moduleId },
          select: { key: true, band: true, vertical: true },
        }),
      ]);
      if (!targetPackage || !targetModule) {
        throw new PlatformSecurityError('Package or module not found.', 400);
      }
      if (targetModule.band === 'BASELINE') {
        throw new PlatformSecurityError('Baseline modules are not sellable package entries.', 400);
      }
      if (targetModule.vertical && targetModule.vertical !== targetPackage.vertical) {
        throw new PlatformSecurityError(
          `The ${targetModule.key} module does not belong to the ${targetPackage.vertical} vertical.`,
          400
        );
      }
      const saved = await db.platformPackageModule.upsert({
        where: {
          packageId_moduleId: { packageId: input.packageId, moduleId: input.moduleId },
        },
        update: { enabled: input.enabled, limits: input.limits ? toJson(input.limits) : undefined },
        create: {
          packageId: input.packageId,
          moduleId: input.moduleId,
          enabled: input.enabled,
          limits: input.limits ? toJson(input.limits) : undefined,
        },
      });
      return { targetType: 'PlatformPackageModule', targetId: saved.id, data: saved, audit: saved };
    }
    case 'deployment.create': {
      const input = z
        .object({
          organizationId: id,
          environment: z
            .string()
            .trim()
            .min(2)
            .max(80)
            .regex(/^[a-z0-9][a-z0-9_-]*$/),
          mode: z.enum(['SHARED', 'DEDICATED']),
          provider: z.string().trim().min(2).max(80).default('VERCEL'),
          region: optionalText.optional(),
          databaseRef: optionalText.optional(),
          queueProvision: z.boolean().default(true),
        })
        .parse(payload);
      const organization = await db.organization.findUnique({
        where: { id: input.organizationId },
        select: { id: true, deploymentMode: true },
      });
      if (!organization) throw new PlatformSecurityError('Organization not found.', 400);
      const existing = await db.organizationDeployment.findUnique({
        where: {
          organizationId_environment: {
            organizationId: input.organizationId,
            environment: input.environment,
          },
        },
        select: { id: true },
      });
      if (existing) {
        throw new PlatformSecurityError(
          `A ${input.environment} deployment is already registered for this organization.`,
          400
        );
      }
      if (input.queueProvision && input.environment !== 'production') {
        throw new PlatformSecurityError(
          'Automated provisioning is currently limited to production. Register other environments without queueing provisioning.',
          400
        );
      }
      const { queueProvision, ...deployment } = input;
      const saved = await db.organizationDeployment.create({
        data: { ...deployment, status: 'PENDING' },
      });
      if (input.environment === 'production' && input.mode !== organization.deploymentMode) {
        await db.organization.update({
          where: { id: input.organizationId },
          data: { deploymentMode: input.mode },
        });
      }
      if (queueProvision) {
        await db.platformJob.create({
          data: {
            organizationId: input.organizationId,
            type: input.mode === 'DEDICATED' ? 'PROVISION_DEDICATED' : 'PROVISION_SHARED',
            requestedById: actor.id,
            payload: {
              environment: input.environment,
              deploymentId: saved.id,
              provider: input.provider,
            },
            idempotencyKey: `provision:${saved.id}`,
          },
        });
      }
      return {
        targetType: 'OrganizationDeployment',
        targetId: saved.id,
        organizationId: saved.organizationId,
        data: saved,
        audit: saved,
      };
    }
    case 'deployment.update': {
      const input = z
        .object({
          id,
          status: z.enum([
            'PENDING',
            'PROVISIONING',
            'READY',
            'DEGRADED',
            'FAILED',
            'DECOMMISSIONED',
          ]),
          provider: z.string().trim().min(2).max(80).optional(),
          projectId: optionalText.optional(),
          region: optionalText.optional(),
          url: z.url().max(2_000).nullish(),
          databaseRef: optionalText.optional(),
          edgeConfigRef: optionalText.optional(),
          version: optionalText.optional(),
        })
        .parse(payload);
      const { id: deploymentId, ...data } = input;
      const saved = await db.organizationDeployment.update({
        where: { id: deploymentId },
        data: {
          ...data,
          lastHealthyAt: input.status === 'READY' ? new Date() : undefined,
        },
      });
      return {
        targetType: 'OrganizationDeployment',
        targetId: saved.id,
        organizationId: saved.organizationId,
        data: saved,
        audit: saved,
      };
    }
    case 'job.create': {
      const input = z
        .object({
          organizationId: optionalId.optional(),
          type: z.enum([
            'PROVISION_SHARED',
            'PROVISION_DEDICATED',
            'CONFIGURE_DOMAIN',
            'APPLY_BRAND',
            'SYNC_IDENTITY',
            'EXPORT_DATA',
            'PURGE_DATA',
            'SUSPEND',
            'RESUME',
          ]),
          scheduledAt: optionalDate.optional(),
          maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
          payload: z.record(z.string(), z.unknown()).nullish(),
        })
        .parse(payload);
      const saved = await db.platformJob.create({
        data: {
          ...input,
          payload: input.payload ? toJson(input.payload) : undefined,
          scheduledAt: input.scheduledAt ?? new Date(),
          requestedById: actor.id,
        },
      });
      return {
        targetType: 'PlatformJob',
        targetId: saved.id,
        organizationId: input.organizationId,
        data: saved,
        audit: jobAudit(saved),
      };
    }
    case 'job.retry': {
      const input = z.object({ id }).parse(payload);
      const before = await db.platformJob.findUnique({ where: { id: input.id } });
      if (!before || !['FAILED', 'CANCELLED'].includes(before.status)) {
        throw new PlatformSecurityError('Only failed or cancelled jobs can be retried.', 400);
      }
      const saved = await db.platformJob.update({
        where: { id: input.id },
        data: {
          status: 'QUEUED',
          attempts: 0,
          error: null,
          result: Prisma.DbNull,
          scheduledAt: new Date(),
          startedAt: null,
          finishedAt: null,
        },
      });
      return {
        targetType: 'PlatformJob',
        targetId: saved.id,
        organizationId: saved.organizationId,
        data: saved,
        audit: jobAudit(saved),
      };
    }
    case 'job.cancel': {
      const input = z.object({ id }).parse(payload);
      const before = await db.platformJob.findUnique({ where: { id: input.id } });
      if (!before || !['QUEUED', 'RUNNING'].includes(before.status)) {
        throw new PlatformSecurityError('Only queued or running jobs can be cancelled.', 400);
      }
      const saved = await db.platformJob.update({
        where: { id: input.id },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      return {
        targetType: 'PlatformJob',
        targetId: saved.id,
        organizationId: saved.organizationId,
        data: saved,
        audit: jobAudit(saved),
      };
    }
    case 'operator.upsert': {
      const input = z
        .object({
          id: optionalId.optional(),
          name: requiredText,
          email,
          password: z.string().min(12).max(256).optional(),
          role: z.enum(['SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'SUPPORT', 'AUDITOR']),
          active: z.boolean().default(true),
          mfaRequired: z.boolean().default(true),
        })
        .parse(payload);
      if (!input.id && !input.password) {
        throw new PlatformSecurityError('A password is required for a new operator.', 400);
      }
      const existingOperator = input.id
        ? await db.platformUser.findUnique({
            where: { id: input.id },
            select: { mfaEnabledAt: true },
          })
        : null;
      if (input.mfaRequired && !existingOperator?.mfaEnabledAt) {
        throw new PlatformSecurityError(
          'The operator must enroll an authenticator before MFA can be required.',
          400
        );
      }
      const passwordHash = input.password ? await hash(input.password, 12) : undefined;
      const saved = input.id
        ? await db.platformUser.update({
            where: { id: input.id },
            data: {
              name: input.name,
              email: input.email,
              role: input.role,
              active: input.active,
              mfaRequired: input.mfaRequired,
              passwordHash,
            },
          })
        : await db.platformUser.create({
            data: {
              name: input.name,
              email: input.email,
              role: input.role,
              active: input.active,
              mfaRequired: input.mfaRequired,
              passwordHash: passwordHash!,
            },
          });
      if (!input.active) {
        await db.platformSession.updateMany({
          where: { platformUserId: saved.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      const safe = omit(saved, 'passwordHash', 'encryptedTotpSecret');
      return { targetType: 'PlatformUser', targetId: saved.id, data: safe, audit: safe };
    }
    case 'operator.mfa.reset': {
      const input = z.object({ id, reason: z.string().trim().min(10).max(500) }).parse(payload);
      const before = await db.platformUser.findUnique({
        where: { id: input.id },
        select: { id: true, email: true, mfaRequired: true, mfaEnabledAt: true },
      });
      if (!before) throw new PlatformSecurityError('Operator not found.', 400);
      await db.platformRecoveryCode.deleteMany({ where: { platformUserId: input.id } });
      const saved = await db.platformUser.update({
        where: { id: input.id },
        data: {
          mfaRequired: false,
          mfaEnabledAt: null,
          encryptedTotpSecret: null,
        },
      });
      await db.platformSession.updateMany({
        where: { platformUserId: input.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return {
        targetType: 'PlatformUser',
        targetId: saved.id,
        auditBefore: before,
        data: { mfaReset: true, reason: input.reason, email: saved.email },
        audit: { mfaReset: true, reason: input.reason, email: saved.email },
      };
    }
    case 'setting.upsert': {
      const input = z
        .object({
          key: z
            .string()
            .trim()
            .min(2)
            .max(120)
            .regex(/^[a-z0-9._-]+$/),
          category: z.string().trim().min(2).max(80),
          value: z.unknown(),
          description: optionalText.optional(),
          sensitive: z.boolean().default(false),
        })
        .parse(payload);
      const existing = await db.platformSetting.findUnique({ where: { key: input.key } });
      const emptyObject =
        input.value !== null &&
        typeof input.value === 'object' &&
        !Array.isArray(input.value) &&
        Object.keys(input.value as Record<string, unknown>).length === 0;
      const storedValue =
        input.sensitive && existing?.sensitive && emptyObject
          ? existing.value === null
            ? Prisma.JsonNull
            : (existing.value as Prisma.InputJsonValue)
          : input.sensitive
            ? toJson({ encrypted: encryptSecret(JSON.stringify(input.value)) })
            : toJson(input.value);
      const saved = await db.platformSetting.upsert({
        where: { key: input.key },
        update: {
          category: input.category,
          value: storedValue,
          description: input.description,
          sensitive: input.sensitive,
          updatedById: actor.id,
        },
        create: {
          key: input.key,
          category: input.category,
          value: storedValue,
          description: input.description,
          sensitive: input.sensitive,
          updatedById: actor.id,
        },
      });
      const { value, ...settingAudit } = saved;
      return {
        targetType: 'PlatformSetting',
        targetId: saved.id,
        data: { ...settingAudit, value: saved.sensitive ? '[REDACTED]' : value },
        // A sensitive setting's stored value is ciphertext, which the ledger
        // must not carry either. Its metadata still records that it changed.
        audit: saved.sensitive ? settingAudit : { ...settingAudit, value },
      };
    }
    default:
      throw new PlatformSecurityError('Unknown platform command.', 400);
  }
}

export async function executePlatformCommand(
  actor: PlatformIdentity,
  actionInput: unknown,
  payload: unknown,
  request: Request
) {
  let action = 'platform.command.invalid';
  try {
    action = z
      .string()
      .trim()
      .min(3)
      .max(100)
      .regex(/^[a-z]+(?:\.[a-z]+)+$/)
      .parse(actionInput);
    assertPlatformCapability(actor, capabilityFor(action));

    return await withPlatformDb(async (db) => {
      const result = await runCommand(db, actor, action, payload);
      // The audit row is built from the command's declared projection only.
      // `result.data` is the reveal channel and never reaches this table.
      const { before, after } = auditProjection(result);
      await db.platformAuditLog.create({
        data: {
          organizationId: result.organizationId,
          actorPlatformUserId: actor.id,
          action,
          targetType: result.targetType,
          targetId: result.targetId,
          before,
          after,
          requestId: request.headers.get('x-devfathom-request-id'),
          ip:
            request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
            request.headers.get('x-real-ip'),
          userAgent: request.headers.get('user-agent')?.slice(0, 500),
        },
      });
      return result.data;
    });
  } catch (error) {
    await persistCommandFailure(actor, action, payload, request, error);
    throw error;
  }
}
