// @vitest-environment node
/**
 * DEV-959A: the second guard behind the sub-role descriptions. Counting action names
 * misses a new procedure added behind an existing gate helper (one `inventoryControl`
 * covers dozens of procedures), so this lists every procedure of every pharmacy router,
 * straight from the routers, and requires each to be mapped in
 * `PHARMACY_PROCEDURE_GATES`: to the gate it sits behind and to the description lines of
 * the sub-roles that grant it, or to a reason no sub-role does. A new procedure with no
 * mapping, or a mapping to a line that does not exist, fails here.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { enforcedProcedureGate } from '@/server/procedure-gate-tag';
import { PHARMACY_PROCEDURE_ENFORCED_GATES } from './pharmacy-procedure-enforced-gates';
import { PHARMACY_PROCEDURE_GATES } from './pharmacy-procedure-gates';
import { PHARMACY_SUB_ROLES } from './pharmacy-sub-roles';

type RouterLike = { _def: { procedures: Record<string, unknown> } };

/** Pharmacy routers called from server actions rather than mounted on the app router. */
const STANDALONE_ROUTERS = [
  [
    'pharmacyJournalEntryLookup',
    () => import('@/lib/pharmacy/accounts/journal-entry-lookup'),
    'journalEntryLookupRouter',
  ],
  ['pharmacyKhata', () => import('@/app/(app)/pharmacy/khata/khata-router'), 'pharmacyKhataRouter'],
  [
    'pharmacyLoyalty',
    () => import('@/app/(app)/pharmacy/loyalty/loyalty-router'),
    'pharmacyLoyaltyRouter',
  ],
  [
    'pharmacyPrepaid',
    () => import('@/app/(app)/pharmacy/loyalty/prepaid-router'),
    'pharmacyPrepaidRouter',
  ],
] as const;

// Tenant administration also exposes these two pharmacy-only role procedures.
function isPharmacyProcedure(path: string) {
  return (
    path.startsWith('pharmacy') ||
    path.startsWith('organizationAdmin.pharmacySettings.') ||
    path === 'organizationAdmin.roleAccess' ||
    path === 'organizationAdmin.setRoleSubRole'
  );
}

async function pharmacyProcedures(): Promise<string[]> {
  const { appRouter } = await import('@/server/routers/_app');
  const paths = Object.keys((appRouter as unknown as RouterLike)._def.procedures).filter(
    isPharmacyProcedure
  );
  for (const [prefix, load, name] of STANDALONE_ROUTERS) {
    const mod = (await load()) as unknown as Record<string, RouterLike>;
    for (const key of Object.keys(mod[name]._def.procedures)) paths.push(`${prefix}.${key}`);
  }
  return paths.sort();
}

const LINE_IDS = new Set(
  PHARMACY_SUB_ROLES.flatMap((subRole) => subRole.allows.map((item) => `${subRole.key}/${item.id}`))
);

describe('every pharmacy procedure is explained by a sub-role or a reason', () => {
  it('maps exactly the procedures the pharmacy routers have', async () => {
    const procedures = await pharmacyProcedures();
    expect(procedures.length).toBeGreaterThan(500);
    expect(Object.keys(PHARMACY_PROCEDURE_GATES).sort()).toEqual(procedures);
  }, 120_000);

  it('names its gate, and either real description lines or a reason', () => {
    for (const [path, entry] of Object.entries(PHARMACY_PROCEDURE_GATES)) {
      expect(entry.gate.length, path).toBeGreaterThan(0);
      if ('lines' in entry) {
        expect(entry.lines.length, path).toBeGreaterThan(0);
        for (const line of entry.lines) expect(LINE_IDS.has(line), `${path} -> ${line}`).toBe(true);
      } else {
        expect(entry.none.length, path).toBeGreaterThan(0);
      }
    }
  });

  it('backs every description line with a use in the code or a procedure', () => {
    const referenced = new Set(
      Object.values(PHARMACY_PROCEDURE_GATES).flatMap((entry) =>
        'lines' in entry ? entry.lines : []
      )
    );
    for (const subRole of PHARMACY_SUB_ROLES) {
      for (const item of subRole.allows) {
        const uses = Object.values(item.sites).reduce((sum, count) => sum + count, 0);
        const id = `${subRole.key}/${item.id}`;
        expect(uses > 0 || referenced.has(id), id).toBe(true);
      }
    }
  });
});

type ProcedureLike = Parameters<typeof enforcedProcedureGate>[0];

/** Every pharmacy procedure object, by path, from the same routers as above. */
async function pharmacyProcedureObjects(): Promise<Map<string, ProcedureLike>> {
  const { appRouter } = await import('@/server/routers/_app');
  const all = (appRouter as unknown as RouterLike)._def.procedures;
  const found = new Map<string, ProcedureLike>();
  for (const [path, procedure] of Object.entries(all))
    if (isPharmacyProcedure(path)) found.set(path, procedure as ProcedureLike);
  for (const [prefix, load, name] of STANDALONE_ROUTERS) {
    const mod = (await load()) as unknown as Record<string, RouterLike>;
    for (const [key, procedure] of Object.entries(mod[name]._def.procedures))
      found.set(`${prefix}.${key}`, procedure as ProcedureLike);
  }
  return found;
}

/**
 * What a map line's gate text says the procedure is built on: base builders, an explicit
 * `capabilityProcedure('action')`, or `meta NAME -> action AND action`. Each named gate must
 * be one the code really enforces.
 */
function claimedGate(text: string): string[] {
  const claims = new Set<string>();
  if (/\badminProcedure\b/.test(text)) claims.add('admin:access');
  if (/\b(?:protectedProcedure|auditedProtectedProcedure)\b/.test(text)) claims.add('signed-in');
  for (const match of text.matchAll(/\bcapabilityProcedure\('?([a-z-]+:[a-zA-Z-]+)'?\)/g))
    claims.add(match[1]);
  const meta = /^meta [A-Z_]+ -> ([a-z-]+:[a-zA-Z-]+(?: AND [a-z-]+:[a-zA-Z-]+)*)/.exec(text);
  for (const action of meta?.[1].split(' AND ') ?? []) claims.add(action);
  return [...claims];
}

describe('DEV-959B: the gate each pharmacy procedure enforces matches the map', () => {
  it('derives every procedure gate from the code and finds it unchanged', async () => {
    const procedures = await pharmacyProcedureObjects();
    const derived = Object.fromEntries(
      [...procedures].map(([path, procedure]) => [path, enforcedProcedureGate(procedure)])
    );
    // A weaker builder (adminProcedure -> protectedProcedure, a capability dropped from
    // .meta) changes the derived gate; update PHARMACY_PROCEDURE_ENFORCED_GATES in review.
    expect(derived).toEqual(
      Object.fromEntries(
        Object.entries(PHARMACY_PROCEDURE_ENFORCED_GATES).map(([path, gate]) => [path, [...gate]])
      )
    );
    expect(Object.keys(PHARMACY_PROCEDURE_ENFORCED_GATES).sort()).toEqual(
      Object.keys(PHARMACY_PROCEDURE_GATES).sort()
    );
  }, 120_000);

  it('never names a gate in the map that the code does not enforce', () => {
    let claimed = 0;
    for (const [path, entry] of Object.entries(PHARMACY_PROCEDURE_GATES)) {
      const enforced = PHARMACY_PROCEDURE_ENFORCED_GATES[path] ?? [];
      for (const gate of claimedGate(entry.gate)) {
        claimed += 1;
        expect(enforced, `${path} claims ${gate}`).toContain(gate);
      }
    }
    // Most lines name their builder; the check must keep reading them.
    expect(claimed).toBeGreaterThan(250);
  });

  it('reads a tagged gate from a built procedure, and a weaker builder reads weaker', async () => {
    const { adminProcedure, capabilityProcedure, denyByDefaultProcedure, protectedProcedure } =
      await import('@/server/trpc');
    const resolve = async () => null;
    expect(
      enforcedProcedureGate(adminProcedure.query(resolve) as unknown as ProcedureLike)
    ).toEqual(['admin:access']);
    expect(
      enforcedProcedureGate(protectedProcedure.query(resolve) as unknown as ProcedureLike)
    ).toEqual(['signed-in']);
    expect(
      enforcedProcedureGate(
        capabilityProcedure('pharmacy:counter').query(resolve) as unknown as ProcedureLike
      )
    ).toEqual(['pharmacy:counter']);
    expect(
      enforcedProcedureGate(
        denyByDefaultProcedure
          .meta({ capabilities: ['pharmacy:procurement', 'reports:financial'] })
          .query(resolve) as unknown as ProcedureLike
      )
    ).toEqual(['pharmacy:procurement', 'reports:financial']);
    expect(
      enforcedProcedureGate(denyByDefaultProcedure.query(resolve) as unknown as ProcedureLike)
    ).toEqual(['refused']);
  });
});
