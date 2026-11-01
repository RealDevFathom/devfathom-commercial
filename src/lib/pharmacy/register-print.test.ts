import { describe, expect, it } from 'vitest';
import {
  chooseRegisterPersonName,
  registerPersonName,
  registerPrintTotals,
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
});
