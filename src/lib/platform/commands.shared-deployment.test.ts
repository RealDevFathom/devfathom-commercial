/**
 * WHA-1180 — `organization.deployment.shared`, at the command boundary
 * (mock-style, modeled on commands.package-inheritance.test.ts).
 *
 * An organization the shared platform hosts already serve should not need a
 * hand-created deployment record before it can activate. This proves the three
 * things that makes safe:
 *
 *   (a) SHARED + a configured base domain writes the default production record
 *       at READY, on the shared tenant host;
 *   (b) it is idempotent — the (organizationId, environment) upsert re-asserts
 *       the same position instead of creating a second row;
 *   (c) a custom-domain (DEDICATED) tenant is refused and told where the manual
 *       path is, and so is an environment with no shared host configured.
 *
 * The preflight half of the same fix is asserted here too: the thrown error
 * carries the structured gates and still reads exactly as it always did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  orgFindUnique: vi.fn(),
  deploymentUpsert: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed'), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
}));

const platformDb = {
  organization: { findUnique: mocks.orgFindUnique, update: vi.fn() },
  organizationDeployment: { upsert: mocks.deploymentUpsert },
  platformAuditLog: { create: mocks.auditCreate },
  $queryRawUnsafe: vi.fn(async () => [{ id: 'org_1' }]),
};

import { executePlatformCommand } from './commands';
import { ActivationPreflightError, PlatformSecurityError } from './security';

const actor = { id: 'op_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });
const reason = 'Shared platform host default applied for activation.';

function run(action: string, payload: unknown) {
  return executePlatformCommand(actor, action, payload, request);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PLATFORM_BASE_DOMAIN', 'staging.devfathom.com');
  mocks.deploymentUpsert.mockImplementation(
    async (args: { create?: unknown; update?: unknown }) => ({
      id: 'dep_1',
      organizationId: 'org_1',
      environment: 'production',
      ...(args.create as object),
    })
  );
  mocks.auditCreate.mockResolvedValue({ id: 'audit_1' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('organization.deployment.shared — shared host default', () => {
  beforeEach(() => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_1',
      slug: 'acme',
      deploymentMode: 'SHARED',
    });
  });

  it('creates the default production record at READY on the shared tenant host', async () => {
    await run('organization.deployment.shared', { organizationId: 'org_1', reason });

    expect(mocks.deploymentUpsert).toHaveBeenCalledTimes(1);
    const args = mocks.deploymentUpsert.mock.calls[0]![0] as {
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(args.where).toEqual({
      organizationId_environment: { organizationId: 'org_1', environment: 'production' },
    });
    expect(args.create).toMatchObject({
      organizationId: 'org_1',
      environment: 'production',
      mode: 'SHARED',
      status: 'READY',
      url: 'https://acme.staging.devfathom.com',
    });
    // The update branch is what makes a second click a no-op rather than a
    // conflict, so it has to assert the same READY shared position.
    expect(args.update).toMatchObject({
      mode: 'SHARED',
      status: 'READY',
      url: 'https://acme.staging.devfathom.com',
    });
  });

  it('is idempotent: a second click writes the same row once more, never a duplicate', async () => {
    await run('organization.deployment.shared', { organizationId: 'org_1', reason });
    await run('organization.deployment.shared', { organizationId: 'org_1', reason });

    expect(mocks.deploymentUpsert).toHaveBeenCalledTimes(2);
    // Both runs addressed the SAME unique key, which is what makes the second
    // one an update of the first rather than a second row. (Only the health
    // timestamp differs between them, so the keys — not the whole args — are
    // the invariant worth asserting.)
    const keys = mocks.deploymentUpsert.mock.calls.map((call) =>
      JSON.stringify((call[0] as { where: unknown }).where)
    );
    expect(keys).toEqual([
      JSON.stringify({
        organizationId_environment: { organizationId: 'org_1', environment: 'production' },
      }),
      JSON.stringify({
        organizationId_environment: { organizationId: 'org_1', environment: 'production' },
      }),
    ]);
    expect(new Set(keys).size).toBe(1);
    // Neither run took the create-only path that `deployment.create` uses.
    expect(platformDb.organization.update).not.toHaveBeenCalled();
  });

  it('audits the operator reason without leaking it into the deployment record', async () => {
    await run('organization.deployment.shared', { organizationId: 'org_1', reason });

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const audit = mocks.auditCreate.mock.calls[0]![0] as {
      data: {
        action: string;
        targetType: string;
        after: Record<string, unknown>;
        reason: string;
        success: boolean;
      };
    };
    expect(audit.data.action).toBe('organization.deployment.shared');
    expect(audit.data.targetType).toBe('OrganizationDeployment');
    expect(audit.data.after).toMatchObject({ reason, status: 'READY' });
    expect(audit.data.reason).toBe(reason);
    expect(audit.data.success).toBe(true);
    // `reason` is audit-only; it is not a column on the deployment row.
    const created = mocks.deploymentUpsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(created.create).not.toHaveProperty('reason');
  });

  it('requires a real operator reason', async () => {
    const error = await run('organization.deployment.shared', {
      organizationId: 'org_1',
      reason: 'too short',
    }).catch((caught: unknown) => caught);

    expect(error).toBeDefined();
    expect(mocks.deploymentUpsert).not.toHaveBeenCalled();
  });
});

describe('organization.deployment.shared — refusals keep the manual path', () => {
  it('refuses a custom-domain (DEDICATED) tenant and names the manual surface', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_1',
      slug: 'acme',
      deploymentMode: 'DEDICATED',
    });

    const error = await run('organization.deployment.shared', {
      organizationId: 'org_1',
      reason,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect((error as PlatformSecurityError).message).toContain('dedicated deployment');
    expect((error as PlatformSecurityError).message).toContain('/platform/deployments');
    expect(mocks.deploymentUpsert).not.toHaveBeenCalled();
  });

  it('refuses when the environment configures no shared host', async () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', '');
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_1',
      slug: 'acme',
      deploymentMode: 'SHARED',
    });

    const error = await run('organization.deployment.shared', {
      organizationId: 'org_1',
      reason,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as PlatformSecurityError).message).toContain('No shared platform host');
    expect(mocks.deploymentUpsert).not.toHaveBeenCalled();
  });

  it('refuses an unknown organization', async () => {
    mocks.orgFindUnique.mockResolvedValue(null);

    const error = await run('organization.deployment.shared', {
      organizationId: 'org_1',
      reason,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as PlatformSecurityError).message).toBe('Organization not found.');
    expect(mocks.deploymentUpsert).not.toHaveBeenCalled();
  });
});

describe('activation preflight carries its unmet gates', () => {
  it('throws the unchanged sentence plus the structured deployment gate', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_1',
      status: 'ONBOARDING',
      activatedAt: null,
      packageId: 'pkg_1',
      vertical: 'AGENCY',
      package: { moduleLinks: [{ moduleId: 'mod_a' }] },
      modules: [],
      users: [{ id: 'admin_1' }],
      deployments: [],
    });

    const error = await run('organization.transition', {
      id: 'org_1',
      status: 'ACTIVE',
      reason: 'Activating after onboarding checks',
    }).catch((caught: unknown) => caught);

    // Still a PlatformSecurityError with the same 400 and the same sentence…
    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toBeInstanceOf(ActivationPreflightError);
    expect(error).toMatchObject({ status: 400 });
    expect((error as Error).message).toBe(
      'Activation preflight failed: add ready production deployment.'
    );
    // …and now also the row the console renders, with its link.
    expect((error as ActivationPreflightError).gates).toEqual([
      {
        gate: 'production_deployment',
        message: 'Add a ready production deployment.',
        action: {
          label: 'Add deployment',
          href: '/platform/deployments?organizationId=org_1',
        },
      },
    ]);
  });
});
