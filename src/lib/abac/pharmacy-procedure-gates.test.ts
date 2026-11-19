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

import { PHARMACY_PROCEDURE_GATES } from './pharmacy-procedure-gates';
import { PHARMACY_SUB_ROLES } from './pharmacy-sub-roles';

type RouterLike = { _def: { procedures: Record<string, unknown> } };

/** Pharmacy routers called from server actions rather than mounted on the app router. */
const STANDALONE_ROUTERS = [
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

async function pharmacyProcedures(): Promise<string[]> {
  const { appRouter } = await import('@/server/routers/_app');
  const paths = Object.keys((appRouter as unknown as RouterLike)._def.procedures).filter((path) =>
    path.startsWith('pharmacy')
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
