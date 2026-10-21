import { describe, expect, it } from 'vitest';
import {
  chooseRegisterPersonName,
  registerPeriodBounds,
  registerPersonName,
  registerPrintTotals,
  withinRegisterPeriod,
} from './register-print';

describe('register print', () => {
  it('uses a person name and refuses a raw id', () => {
    expect(registerPersonName('Ayesha Khan', 'user_1')).toBe('Ayesha Khan');
    expect(
      registerPersonName('user_qa_pharmacist_witness', 'user_qa_pharmacist_witness')
    ).toBeNull();
    expect(registerPersonName('  ', 'user_1')).toBeNull();
    expect(chooseRegisterPersonName(['user_1', 'Pharmacist Witness'], 'user_1')).toBe(
      'Pharmacist Witness'
    );
  });

  it('totals units in and out and keeps one closing balance per lot', () => {
    const totals = registerPrintTotals([
      {
        inventoryLotId: 'lot-a',
        batchNumber: 'CD-QA-1001',
        balanceDelta: 10,
        runningBalance: 10,
        serial: 1,
      },
      {
        inventoryLotId: 'lot-a',
        batchNumber: 'CD-QA-1001',
        balanceDelta: -2,
        runningBalance: 8,
        serial: 2,
      },
      {
        inventoryLotId: 'lot-b',
        batchNumber: 'CD-QA-UI',
        balanceDelta: 5,
        runningBalance: 5,
        serial: 3,
      },
    ]);
    expect(totals).toMatchObject({ rows: 3, unitsIn: 15, unitsOut: 2 });
    expect(totals.closing).toEqual([
      { batchNumber: 'CD-QA-1001', runningBalance: 8, serial: 2 },
      { batchNumber: 'CD-QA-UI', runningBalance: 5, serial: 3 },
    ]);
  });

  it('bounds a period on Karachi (UTC+5) calendar-day edges', () => {
    const bounds = registerPeriodBounds('2026-10-01', '2026-10-31');
    // 2026-10-01 00:00 PKT is 2026-09-30 19:00 UTC.
    expect(bounds.fromMs).toBe(Date.parse('2026-09-30T19:00:00.000Z'));
    // 2026-10-31 23:59:59.999 PKT is 2026-10-31 18:59:59.999 UTC.
    expect(bounds.toMs).toBe(Date.parse('2026-10-31T18:59:59.999Z'));

    const open = registerPeriodBounds('', '');
    expect(open).toEqual({ fromMs: null, toMs: null });
  });

  it('keeps entries inside the period and drops those outside it', () => {
    const bounds = registerPeriodBounds('2026-10-01', '2026-10-31');
    // Midnight Karachi on the 1st is inside; a second before is outside.
    expect(withinRegisterPeriod(new Date('2026-09-30T19:00:00.000Z'), bounds)).toBe(true);
    expect(withinRegisterPeriod(new Date('2026-09-30T18:59:59.000Z'), bounds)).toBe(false);
    expect(withinRegisterPeriod(new Date('2026-10-31T18:59:59.999Z'), bounds)).toBe(true);
    expect(withinRegisterPeriod(new Date('2026-11-01T00:00:00.000Z'), bounds)).toBe(false);
    // An open period keeps everything.
    expect(
      withinRegisterPeriod(new Date('2000-01-01T00:00:00.000Z'), { fromMs: null, toMs: null })
    ).toBe(true);
  });
});
