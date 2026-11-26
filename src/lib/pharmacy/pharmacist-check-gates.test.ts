import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/abac', () => ({ can: vi.fn(async () => false) }));

import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PharmacyDispensingError } from './dispensing';
import { counterAlertsFor, hasBlockingAlert, type CounterAlertLine } from './counter-alerts';
import { PHARMACIST_CHECK_OFF_NOTE } from './pharmacist-check';
import { assertRxLinesPrescribed, PharmacyRxReferenceError } from './rx-prescription-reference';
import { assertRxSaleAllowed, PharmacyRxSaleDenied } from './rx-sale-gate';

// DEV-911: with the owner's setting OFF, a prescription-only or controlled medicine sells like
// any other item. With it ON, missing, or unreadable, every gate refuses exactly as before.

type Stored = 'ON' | 'OFF' | 'MISSING' | 'UNREADABLE';

function dbWith(stored: Stored, extra: Record<string, unknown> = {}) {
  const findUnique = vi.fn(async () => {
    if (stored === 'UNREADABLE') throw new Error('policy read failed');
    if (stored === 'MISSING') return null;
    return {
      pharmacistCheckEnabled: stored === 'ON',
      pharmacistCheckPolicyVersion: stored === 'ON' ? 2 : 1,
    };
  });
  return {
    db: { pharmacyOwnerPolicy: { findUnique }, ...extra } as unknown as ScopedDb,
    findUnique,
  };
}

const RX = { rx: true, restricted: false, controlled: false };
const RESTRICTED = { rx: false, restricted: true, controlled: false };
const OTC = { rx: false, restricted: false, controlled: false };
const CASHIER = { organizationId: 'org-1', actorId: 'cashier-1' };

beforeEach(() => {
  vi.mocked(can).mockReset();
  vi.mocked(can).mockResolvedValue(false);
});

describe('assertRxSaleAllowed reads the owner setting', () => {
  it('lets a cashier sell a prescription-only line while the owner has the check off', async () => {
    const { db, findUnique } = dbWith('OFF');
    await expect(assertRxSaleAllowed(db, CASHIER, [RX, RESTRICTED])).resolves.toBeUndefined();
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1' } })
    );
  });

  it.each<Stored>(['ON', 'MISSING', 'UNREADABLE'])(
    'still refuses a cashier when the setting is %s',
    async (stored) => {
      const { db } = dbWith(stored);
      await expect(assertRxSaleAllowed(db, CASHIER, [RX])).rejects.toBeInstanceOf(
        PharmacyRxSaleDenied
      );
    }
  );

  it('reads nothing for an over-the-counter sale or for a pharmacist', async () => {
    const { db, findUnique } = dbWith('OFF');
    await assertRxSaleAllowed(db, CASHIER, [OTC]);
    vi.mocked(can).mockResolvedValue(true);
    await assertRxSaleAllowed(db, CASHIER, [RX]);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('keeps the gate on when the caller names no organization', async () => {
    const { db } = dbWith('OFF');
    await expect(assertRxSaleAllowed(db, { actorId: 'cashier-1' }, [RX])).rejects.toBeInstanceOf(
      PharmacyRxSaleDenied
    );
  });
});

describe('assertRxLinesPrescribed reads the owner setting', () => {
  const unprescribed = [{ id: 'line-1', prescriptionLineId: null, medicine: RX }];
  const unsigned = [{ id: 'line-1', prescriptionLineId: 'rx-line-1', medicine: RX }];
  const noSignature = {
    pharmacyPharmacistReviewDecision: { findFirst: vi.fn(async () => null) },
  };

  it('needs no prescription and no pharmacist signature while the check is off', async () => {
    await expect(
      assertRxLinesPrescribed(dbWith('OFF', noSignature).db, unprescribed, CASHIER)
    ).resolves.toBeUndefined();
    await expect(
      assertRxLinesPrescribed(dbWith('OFF', noSignature).db, unsigned, CASHIER)
    ).resolves.toBeUndefined();
  });

  it.each<Stored>(['ON', 'MISSING', 'UNREADABLE'])(
    'still demands the prescription and signed review when the setting is %s',
    async (stored) => {
      await expect(
        assertRxLinesPrescribed(dbWith(stored, noSignature).db, unprescribed, CASHIER)
      ).rejects.toMatchObject({ reason: 'PRESCRIPTION_REQUIRED' });
      await expect(
        assertRxLinesPrescribed(dbWith(stored, noSignature).db, unsigned, CASHIER)
      ).rejects.toBeInstanceOf(PharmacyDispensingError);
    }
  );

  it('keeps the gate on when the caller passes no organization', async () => {
    await expect(
      assertRxLinesPrescribed(dbWith('OFF', noSignature).db, unprescribed)
    ).rejects.toBeInstanceOf(PharmacyRxReferenceError);
  });

  it('does not swallow an unrelated failure while the check is off', async () => {
    const broken = {
      pharmacyPharmacistReviewDecision: {
        findFirst: vi.fn(async () => {
          throw new Error('database down');
        }),
      },
    };
    await expect(
      assertRxLinesPrescribed(dbWith('OFF', broken).db, unsigned, CASHIER)
    ).rejects.toThrow('database down');
  });
});

describe('a controlled line added while the check was off', () => {
  const CONTROLLED = { rx: false, restricted: false, controlled: true };
  const lines = [
    {
      id: 'line-c',
      prescriptionLineId: null,
      medicine: CONTROLLED,
      allocations: [{ stockMovementId: 'movement-1' }, { stockMovementId: 'movement-2' }],
    },
  ];
  function registerDb(stored: Stored, marked: boolean) {
    const findFirst = vi.fn(async () => (marked ? { id: 'entry-1' } : null));
    const { db } = dbWith(stored, { pharmacyControlledRegisterEntry: { findFirst } });
    return { db, findFirst };
  }

  it.each<Stored>(['ON', 'MISSING', 'UNREADABLE'])(
    'is refused at tender and completion once the setting is %s again',
    async (stored) => {
      const { db, findFirst } = registerDb(stored, true);
      await expect(assertRxLinesPrescribed(db, lines, CASHIER)).rejects.toMatchObject({
        reason: 'CONTROLLED_LINE_UNCHECKED',
      });
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org-1',
            entryKind: 'SALE',
            stockMovementId: { in: ['movement-1', 'movement-2'] },
            signatureRef: { startsWith: 'pharmacist-check-off:' },
          }),
        })
      );
    }
  );

  it('refuses the unchecked controlled line even while the check is off', async () => {
    const { db } = registerDb('OFF', true);
    await expect(assertRxLinesPrescribed(db, lines, CASHIER)).rejects.toMatchObject({
      reason: 'CONTROLLED_LINE_UNCHECKED',
    });
  });

  it('leaves a controlled line a pharmacist authorized untouched', async () => {
    const { db } = registerDb('ON', false);
    await expect(assertRxLinesPrescribed(db, lines, CASHIER)).resolves.toBeUndefined();
  });

  it('reads nothing for a bill with no controlled line', async () => {
    const { db, findFirst } = registerDb('ON', true);
    await assertRxLinesPrescribed(
      db,
      [
        {
          id: 'line-o',
          prescriptionLineId: null,
          medicine: OTC,
          allocations: [{ stockMovementId: 'm' }],
        },
      ],
      CASHIER
    );
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('counter alerts follow the owner setting', () => {
  const line = (medicine: Partial<CounterAlertLine['medicine']>): CounterAlertLine => ({
    ref: 'line-1',
    medicine: {
      medicineId: 'medicine-1',
      displayName: 'Medicine A',
      rx: false,
      controlled: false,
      restricted: false,
      highAlert: false,
      lasa: false,
      coldChain: false,
      ...medicine,
    },
    blocked: [],
    prescription: null,
    requestedCanonicalUnits: 1,
    nearestSafeExpiry: null,
    discountMinor: 0,
  });
  const at = new Date('2026-11-18T09:00:00.000Z');

  it.each([{ rx: true }, { restricted: true }])(
    'shows the plain note instead of the prescription block while off (%o)',
    (medicine) => {
      const alerts = counterAlertsFor([line(medicine)], { at, pharmacistCheckOff: true });
      expect(hasBlockingAlert(alerts)).toBe(false);
      expect(alerts).toEqual([
        expect.objectContaining({
          severity: 'CLINICAL_ADVICE',
          code: 'PHARMACIST_CHECK_SWITCHED_OFF',
          message: `Medicine A: ${PHARMACIST_CHECK_OFF_NOTE}.`,
          saleLineRef: 'line-1',
        }),
      ]);
    }
  );

  it('keeps the controlled prescription block with both switches off', () => {
    expect(
      hasBlockingAlert(
        counterAlertsFor([line({ controlled: true })], { at, pharmacistCheckOff: true })
      )
    ).toBe(true);
  });

  it('keeps the prescription block when the setting is on or unknown', () => {
    for (const pharmacistCheckOff of [false, undefined]) {
      const alerts = counterAlertsFor([line({ rx: true })], { at, pharmacistCheckOff });
      expect(hasBlockingAlert(alerts)).toBe(true);
      expect(alerts.map((alert) => alert.code)).toEqual(['RX_WITHOUT_PRESCRIPTION']);
    }
  });

  it('adds no note to an over-the-counter line', () => {
    expect(counterAlertsFor([line({})], { at, pharmacistCheckOff: true })).toEqual([]);
  });
});

/**
 * Guard: every server place that refuses a sale for want of a pharmacist's verification or a
 * prescription must consult the one setting reader. A new refusal site that does not fails
 * here, so the owner's switch cannot be silently ignored by a later path.
 */
describe('every pharmacist-verification gate consults the owner setting', () => {
  const ROOT = join(process.cwd(), 'src');
  const READERS =
    /\b(pharmacistCheckAtSaleEnabled|readPharmacistCheckPolicy|pharmacistCheckOffMarker)\(/;
  const REFUSALS: Array<[label: string, pattern: RegExp]> = [
    ['Rx sale grant refusal', /new PharmacyRxSaleDenied\(/],
    ['missing prescription refusal', /PharmacyRxReferenceError\('PRESCRIPTION_REQUIRED'\)/],
    ['unsigned pharmacist review refusal', /assertPharmacistApproved\(/],
    ['controlled dispense refusal', /permission to dispense a controlled medicine/],
    [
      'controlled authorization refusal',
      /independent pharmacist PIN, and either a valid prescription/,
    ],
    ['refill pharmacist hold', /RefillSubscriptionError\('PHARMACIST_APPROVAL_REQUIRED'\)/],
    ['refill prescription requirement', /RefillSubscriptionError\('PRESCRIPTION_REQUIRED'\)/],
    ['refill cycle held for a pharmacist', /'AWAITING_PHARMACIST' : 'RESERVED'/],
  ];

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'generated' ? [] : sources(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  const files = sources(ROOT).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it.each(REFUSALS)('%s is only raised where the setting is read', (_label, pattern) => {
    const sites = files.filter((file) => pattern.test(file.text));
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      // The definition of assertPharmacistApproved itself lives in dispensing.ts; its only
      // sale-time caller is assertRxLinesPrescribed, which reads the setting.
      if (site.path.endsWith(join('pharmacy', 'dispensing.ts'))) continue;
      expect(
        READERS.test(site.text),
        `${site.path.replace(ROOT, 'src')} refuses a sale without reading the owner setting`
      ).toBe(true);
    }
  });

  function body(path: string[], name: string): string {
    const text = files.find((file) => file.path.endsWith(join(...path)))!.text;
    const start = text.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
    const next = text.indexOf('\nexport ', start + 1);
    return text.slice(start, next < 0 ? undefined : next);
  }

  it.each(['openRefillCycle', 'startRefillCycleCheckout'])(
    'the refill path %s reads the setting',
    (name) => {
      expect(READERS.test(body(['pharmacy', 'refill-subscriptions.ts'], name))).toBe(true);
    }
  );

  it.each(['changeSaleStatus', 'returnSaleLine'])(
    'the controlled void/return path %s takes its witness through the setting-aware helper',
    (name) => {
      const text = body(['pharmacy', 'sales.ts'], name);
      expect(text).toContain('controlledSaleRestorationWitness(');
      expect(text).not.toMatch(/\bauthorizeControlledRestoration\(/);
    }
  );

  it('the only direct counter-restoration witness call is inside the setting-aware helper', () => {
    const sales = files.find((file) => file.path.endsWith(join('pharmacy', 'sales.ts')))!.text;
    expect(sales.match(/\bawait authorizeControlledRestoration\(/g)).toHaveLength(1);
    expect(READERS.test(body(['pharmacy', 'sales.ts'], 'controlledSaleRestorationWitness'))).toBe(
      true
    );
  });

  it('the controlled sale refuses an unqualified dispenser before allocating any stock', () => {
    const router = files.find((file) =>
      file.path.endsWith(join('server', 'routers', 'pharmacy-sales.ts'))
    )!.text;
    const gate = router.slice(router.indexOf('const mayDispense ='));
    expect(gate.indexOf('if (!mayDispense)')).toBeGreaterThan(0);
    expect(gate.indexOf('A pharmacist must approve this controlled medicine.')).toBeLessThan(
      gate.indexOf('await addSaleLine(')
    );
    expect(
      gate.slice(0, gate.indexOf('const pharmacist = await confirmControlledApproval'))
    ).not.toContain('pharmacistCheckOffSignature');
  });
});
