import { describe, expect, it } from 'vitest';

import {
  counterAlertsFor,
  hasBlockingAlert,
  type CounterAlertLine,
  type CounterAlertMedicine,
} from './counter-alerts';

const AT = new Date('2026-09-02T09:00:00.000Z');

function medicine(overrides: Partial<CounterAlertMedicine> = {}): CounterAlertMedicine {
  return {
    medicineId: 'med-1',
    displayName: 'Panadol',
    rx: false,
    controlled: false,
    restricted: false,
    highAlert: false,
    lasa: false,
    coldChain: false,
    ...overrides,
  };
}

function line(overrides: Partial<CounterAlertLine> = {}): CounterAlertLine {
  return {
    ref: 'line-1',
    medicine: medicine(),
    blocked: [],
    prescription: null,
    requestedCanonicalUnits: 10,
    nearestSafeExpiry: null,
    discountMinor: 0,
    ...overrides,
  };
}

describe('counterAlertsFor (POS-09)', () => {
  it('raises nothing for a plain over-the-counter line', () => {
    expect(counterAlertsFor([line()], { at: AT })).toEqual([]);
  });

  it('blocks a prescription-only line with no prescription attached', () => {
    const alerts = counterAlertsFor([line({ medicine: medicine({ rx: true }) })], { at: AT });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('SAFETY_BLOCK');
    expect(alerts[0]!.code).toBe('RX_WITHOUT_PRESCRIPTION');
    expect(alerts[0]!.remedy).toBeTruthy();
    expect(hasBlockingAlert(alerts)).toBe(true);
  });

  it('names a controlled medicine distinctly from an ordinary Rx item', () => {
    const alerts = counterAlertsFor([line({ medicine: medicine({ controlled: true }) })], {
      at: AT,
    });
    expect(alerts[0]!.code).toBe('CONTROLLED_WITHOUT_PRESCRIPTION');
  });

  it('lets a recorded emergency controlled supply be paid, keeping the follow-up notice', () => {
    const alerts = counterAlertsFor(
      [line({ medicine: medicine({ controlled: true }), emergencySupply: true })],
      { at: AT }
    );
    expect(hasBlockingAlert(alerts)).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'CLINICAL_ADVICE',
      code: 'CONTROLLED_EMERGENCY_SUPPLY',
      saleLineRef: 'line-1',
    });
  });

  it('does not let the emergency flag excuse a non-controlled Rx line', () => {
    const alerts = counterAlertsFor(
      [line({ medicine: medicine({ rx: true }), emergencySupply: true })],
      { at: AT }
    );
    expect(hasBlockingAlert(alerts)).toBe(true);
    expect(alerts[0]!.code).toBe('RX_WITHOUT_PRESCRIPTION');
  });

  it('clears once a verified, in-date, sufficient prescription is attached', () => {
    const alerts = counterAlertsFor(
      [
        line({
          medicine: medicine({ rx: true }),
          prescription: {
            id: 'rx-1',
            verified: true,
            expiresAt: new Date('2026-12-01T00:00:00.000Z'),
            remainingAuthorizedUnits: 30,
          },
        }),
      ],
      { at: AT }
    );
    expect(alerts).toEqual([]);
  });

  it('blocks an unverified, expired, or over-drawn prescription separately', () => {
    const alerts = counterAlertsFor(
      [
        line({
          medicine: medicine({ rx: true }),
          requestedCanonicalUnits: 40,
          prescription: {
            id: 'rx-1',
            verified: false,
            expiresAt: new Date('2026-01-01T00:00:00.000Z'),
            remainingAuthorizedUnits: 30,
          },
        }),
      ],
      { at: AT }
    );
    expect(alerts.map((alert) => alert.code).sort()).toEqual([
      'PRESCRIPTION_EXPIRED',
      'PRESCRIPTION_NOT_VERIFIED',
      'PRESCRIPTION_QUANTITY_EXCEEDED',
    ]);
    expect(alerts.every((alert) => alert.severity === 'SAFETY_BLOCK')).toBe(true);
  });

  it('never offers acknowledgement as a way past a block', () => {
    const alerts = counterAlertsFor(
      [
        line({
          medicine: medicine({ rx: true }),
          prescription: {
            id: 'rx-1',
            verified: false,
            expiresAt: new Date('2026-12-01T00:00:00.000Z'),
            remainingAuthorizedUnits: 30,
          },
        }),
      ],
      { at: AT }
    );
    for (const alert of alerts) {
      expect(alert.remedy).not.toMatch(/are you sure|acknowledge|confirm to continue/i);
    }
  });

  it('separates clinical advice from commercial notices', () => {
    const alerts = counterAlertsFor(
      [
        line({
          medicine: medicine({ lasa: true, coldChain: true }),
          nearestSafeExpiry: new Date('2026-10-01T00:00:00.000Z'),
        }),
      ],
      { at: AT }
    );
    const bySeverity = Object.fromEntries(alerts.map((alert) => [alert.code, alert.severity]));
    expect(bySeverity.LOOK_ALIKE_SOUND_ALIKE).toBe('CLINICAL_ADVICE');
    expect(bySeverity.COLD_CHAIN_HANDLING).toBe('CLINICAL_ADVICE');
    expect(bySeverity.NEAR_EXPIRY_BATCH).toBe('COMMERCIAL');
    expect(hasBlockingAlert(alerts)).toBe(false);
  });

  it('turns every INV-03 hard block into a safety block', () => {
    const alerts = counterAlertsFor([line({ blocked: ['EXPIRED', 'RECALLED'] })], { at: AT });
    expect(alerts.map((alert) => alert.code).sort()).toEqual(['STOCK_EXPIRED', 'STOCK_RECALLED']);
    expect(alerts.every((alert) => alert.severity === 'SAFETY_BLOCK')).toBe(true);
  });

  it('deduplicates the same alert across four lines of one medicine', () => {
    const lines = ['a', 'b', 'c', 'd'].map((ref) =>
      line({ ref, medicine: medicine({ controlled: true }) })
    );
    const alerts = counterAlertsFor(lines, { at: AT });
    expect(alerts).toHaveLength(1);
    // The surviving alert still points at a real cart line.
    expect(alerts[0]!.saleLineRef).toBe('a');
  });

  it('keeps distinct medicines distinct', () => {
    const alerts = counterAlertsFor(
      [
        line({ ref: 'a', medicine: medicine({ medicineId: 'med-1', controlled: true }) }),
        line({
          ref: 'b',
          medicine: medicine({ medicineId: 'med-2', displayName: 'Morphine', controlled: true }),
        }),
      ],
      { at: AT }
    );
    expect(alerts).toHaveLength(2);
  });

  it('orders safety blocks ahead of advice and commercial notices', () => {
    const alerts = counterAlertsFor(
      [
        line({
          medicine: medicine({ rx: true, lasa: true }),
          nearestSafeExpiry: new Date('2026-09-20T00:00:00.000Z'),
        }),
      ],
      { at: AT }
    );
    expect(alerts.map((alert) => alert.severity)).toEqual([
      'SAFETY_BLOCK',
      'CLINICAL_ADVICE',
      'COMMERCIAL',
    ]);
  });

  it('flags a discount on a regulated item as commercial, not as a block', () => {
    const alerts = counterAlertsFor(
      [
        line({
          medicine: medicine({ restricted: true }),
          discountMinor: 500,
          prescription: {
            id: 'rx-1',
            verified: true,
            expiresAt: new Date('2026-12-01T00:00:00.000Z'),
            remainingAuthorizedUnits: 30,
          },
        }),
      ],
      { at: AT }
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.code).toBe('REGULATED_DISCOUNT_REFUSED');
    expect(alerts[0]!.severity).toBe('COMMERCIAL');
  });

  it('does not warn about an expiry well beyond the near-expiry window', () => {
    const alerts = counterAlertsFor(
      [line({ nearestSafeExpiry: new Date('2028-01-01T00:00:00.000Z') })],
      { at: AT }
    );
    expect(alerts).toEqual([]);
  });

  it('honours a configured near-expiry window', () => {
    const alerts = counterAlertsFor(
      [line({ nearestSafeExpiry: new Date('2026-09-20T00:00:00.000Z') })],
      { at: AT, nearExpiryDays: 5 }
    );
    expect(alerts).toEqual([]);
  });
});

describe('counterAlertsFor duplicate active salt (#724)', () => {
  const paracetamol = { ingredientId: 'ing-pcm', name: 'Paracetamol' };

  it('warns, without blocking, when two paracetamol brands share a bill', () => {
    const alerts = counterAlertsFor(
      [
        line({
          ref: 'line-1',
          medicine: medicine({
            medicineId: 'panadol',
            displayName: 'Panadol',
            activeIngredients: [paracetamol],
          }),
        }),
        line({
          ref: 'line-2',
          medicine: medicine({
            medicineId: 'calpol',
            displayName: 'Calpol',
            activeIngredients: [paracetamol],
          }),
        }),
      ],
      { at: AT }
    );
    expect(alerts).toEqual([
      {
        key: 'duplicate-salt:paracetamol',
        severity: 'CLINICAL_ADVICE',
        code: 'DUPLICATE_ACTIVE_INGREDIENT',
        message: 'Panadol, Calpol both contain Paracetamol. Check the patient is not double-dosing.',
        saleLineRef: 'line-1',
        remedy: 'Confirm each is intended, then acknowledge. The sale is not blocked.',
        acknowledgement: { kind: 'DUPLICATE_ACTIVE_INGREDIENT', ingredientKey: 'paracetamol' },
      },
    ]);
    expect(hasBlockingAlert(alerts)).toBe(false);
  });

  it('keeps existing blocks ahead of the duplicate-salt advice', () => {
    const alerts = counterAlertsFor(
      [
        line({
          ref: 'line-1',
          medicine: medicine({ medicineId: 'a', rx: true, activeIngredients: [paracetamol] }),
        }),
        line({
          ref: 'line-2',
          medicine: medicine({ medicineId: 'b', activeIngredients: [paracetamol] }),
        }),
      ],
      { at: AT }
    );
    expect(alerts.map((alert) => alert.code)).toEqual([
      'RX_WITHOUT_PRESCRIPTION',
      'DUPLICATE_ACTIVE_INGREDIENT',
    ]);
    expect(hasBlockingAlert(alerts)).toBe(true);
  });

  it('raises nothing for one medicine on two lines, or when ingredient data is absent', () => {
    expect(
      counterAlertsFor(
        [
          line({ ref: 'line-1', medicine: medicine({ activeIngredients: [paracetamol] }) }),
          line({ ref: 'line-2', medicine: medicine({ activeIngredients: [paracetamol] }) }),
        ],
        { at: AT }
      )
    ).toEqual([]);
    expect(
      counterAlertsFor(
        [
          line({ ref: 'line-1', medicine: medicine({ medicineId: 'a' }) }),
          line({ ref: 'line-2', medicine: medicine({ medicineId: 'b' }) }),
        ],
        { at: AT }
      )
    ).toEqual([]);
  });
});
