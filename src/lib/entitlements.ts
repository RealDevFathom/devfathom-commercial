import 'server-only';

import type { Prisma } from '@/generated/prisma/client';
import {
  isVerticalBaselineModule,
  moduleDefinitionForKey,
  verticalBaselineModules,
  type EntitlementView,
} from '@/lib/module-catalog';
import { withPlatformDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

type ModuleState = EntitlementView['modules'][number] & {
  limits: Record<string, number>;
};

function numericLimits(value: Prisma.JsonValue | null | undefined): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .map(([key, limit]) => [key, Math.max(0, Math.floor(limit))])
  );
}

/**
 * Package defaults establish the baseline, live contracts can add commercial
 * modules, and organization overrides are final (including explicit disable).
 */
export async function resolveOrganizationEntitlements(
  organizationId: string,
  db: Pick<ScopedDb, 'organization' | 'organizationModule' | 'organizationLimit' | 'user'>,
  now = new Date()
): Promise<EntitlementView> {
  const organizationPromise = db.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      seatLimit: true,
      packageId: true,
      // §2.3 — additive: surfaced on the view below. Selecting one more
      // scalar does not affect the package → contract → override resolution
      // order applied further down.
      vertical: true,
    },
  });
  const [tenantState, controlState] = await Promise.all([
    Promise.all([
      organizationPromise,
      db.organizationModule.findMany({
        where: { organizationId },
        select: {
          moduleId: true,
          status: true,
          seatLimit: true,
          startsAt: true,
          expiresAt: true,
          overrides: true,
        },
      }),
      db.organizationLimit.findMany({
        where: {
          organizationId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { key: true, value: true },
      }),
      db.user.count({
        where: {
          organizationId,
          status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] },
        },
      }),
    ]),
    // Catalog, package, and contract records are deliberately protected by the
    // control-plane-only RLS policy. Resolve that half of the entitlement
    // snapshot in a separate privileged transaction, never by weakening RLS.
    withPlatformDb(async (platformDb) => {
      const organization = await organizationPromise;
      const [catalog, packageRecord, contracts] = await Promise.all([
        platformDb.platformModule.findMany({
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, key: true, name: true, band: true },
        }),
        organization?.packageId
          ? platformDb.platformPackage.findUnique({
              where: { id: organization.packageId },
              select: {
                moduleLinks: {
                  where: { enabled: true },
                  select: {
                    limits: true,
                    module: { select: { id: true, active: true } },
                  },
                },
              },
            })
          : null,
        platformDb.platformContract.findMany({
          where: {
            organizationId,
            status: { in: ['ACTIVE', 'GRACE', 'RENEWAL_DUE'] },
            startDate: { lte: now },
            OR: [{ endDate: { gte: now } }, { graceUntil: { gte: now } }],
          },
          orderBy: { endDate: 'desc' },
          select: {
            seatLimit: true,
            endDate: true,
            graceUntil: true,
            modules: {
              select: {
                seatLimit: true,
                limits: true,
                module: { select: { id: true, active: true } },
              },
            },
          },
        }),
      ]);
      return { catalog, packageRecord, contracts };
    }),
  ]);

  const [organization, overrides, limits, activeSeats] = tenantState;
  const { catalog, packageRecord, contracts } = controlState;
  if (!organization) throw new Error('Organization not found.');

  const states = new Map<string, ModuleState>();
  for (const catalogModule of catalog) {
    // DEV-913: a vertical's core shared modules (the pharmacy audit log) are
    // baseline for that vertical, so no package, contract or override drops them.
    const baseline =
      catalogModule.band === 'BASELINE' ||
      isVerticalBaselineModule(organization.vertical, catalogModule.key);
    states.set(catalogModule.id, {
      key: catalogModule.key,
      name: catalogModule.name,
      enabled: baseline,
      source: baseline ? 'BASELINE' : 'NONE',
      seatLimit: null,
      expiresAt: null,
      limits: {},
    });
  }
  for (const key of verticalBaselineModules(organization.vertical)) {
    if ([...states.values()].some((state) => state.key === key)) continue;
    states.set(`vertical-baseline:${key}`, {
      key,
      name: moduleDefinitionForKey(key)?.name ?? key,
      enabled: true,
      source: 'BASELINE',
      seatLimit: null,
      expiresAt: null,
      limits: {},
    });
  }

  for (const link of packageRecord?.moduleLinks ?? []) {
    if (!link.module.active) continue;
    const state = states.get(link.module.id);
    if (!state || state.source === 'BASELINE') continue;
    Object.assign(state, {
      enabled: true,
      source: 'PACKAGE' as const,
      limits: numericLimits(link.limits),
    });
  }

  let effectiveSeatLimit = organization.seatLimit;
  for (const contract of contracts) {
    effectiveSeatLimit = Math.max(effectiveSeatLimit, contract.seatLimit);
    const expiresAt = (contract.graceUntil ?? contract.endDate).toISOString();
    for (const link of contract.modules) {
      if (!link.module.active) continue;
      const state = states.get(link.module.id);
      if (!state || state.source === 'BASELINE' || state.source === 'CONTRACT') continue;
      Object.assign(state, {
        enabled: true,
        source: 'CONTRACT' as const,
        seatLimit: link.seatLimit,
        expiresAt,
        limits: { ...state.limits, ...numericLimits(link.limits) },
      });
    }
  }

  for (const override of overrides) {
    const state = states.get(override.moduleId);
    if (!state || state.source === 'BASELINE') continue;
    const inWindow = override.startsAt <= now && (!override.expiresAt || override.expiresAt > now);
    Object.assign(state, {
      enabled: inWindow && (override.status === 'ENABLED' || override.status === 'TRIAL'),
      source: 'OVERRIDE' as const,
      seatLimit: override.seatLimit,
      expiresAt: override.expiresAt?.toISOString() ?? null,
      limits: { ...state.limits, ...numericLimits(override.overrides) },
    });
  }

  const effectiveLimits: Record<string, number> = Object.fromEntries(
    limits.map((limit) => [limit.key, limit.value])
  );
  for (const state of states.values()) {
    for (const [key, value] of Object.entries(state.limits)) {
      effectiveLimits[`${state.key}.${key}`] = value;
    }
  }

  const serializedModules = [...states.values()].map((state) => ({
    key: state.key,
    name: state.name,
    enabled: state.enabled,
    source: state.source,
    seatLimit: state.seatLimit,
    expiresAt: state.expiresAt,
  }));
  return {
    organizationId,
    vertical: organization.vertical,
    seatLimit: effectiveSeatLimit,
    activeSeats,
    enabledModules: serializedModules
      .filter((module) => module.enabled)
      .map((module) => module.key),
    modules: serializedModules,
    limits: effectiveLimits,
  };
}

export function hasModule(entitlements: EntitlementView, moduleKey: string): boolean {
  return entitlements.enabledModules.includes(moduleKey);
}

export function assertSeatAvailable(entitlements: EntitlementView): void {
  if (entitlements.activeSeats >= entitlements.seatLimit) {
    throw new Error(`Seat limit reached (${entitlements.activeSeats}/${entitlements.seatLimit}).`);
  }
}
