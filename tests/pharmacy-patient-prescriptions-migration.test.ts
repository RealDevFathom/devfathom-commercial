import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { moduleForProcedure } from '@/lib/module-catalog';

const sql = readFileSync(
  'prisma/migrations/20260902140000_pharmacy_patient_prescriptions/migration.sql',
  'utf8'
);
const tables = [
  'pharmacy_patients',
  'pharmacy_patient_consents',
  'pharmacy_prescribers',
  'pharmacy_prescriptions',
  'pharmacy_prescription_lines',
  'pharmacy_prescription_fills',
];

describe('RX-01/RX-02 migration contract', () => {
  it('creates every RX table under forced tenant RLS', () => {
    for (const table of tables) expect(sql).toContain(`'${table}'`);
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
  });
  it('makes prescriptions, lines, fills and consent events append-only', () => {
    for (const trigger of [
      'pharmacy_consent_append_only',
      'pharmacy_prescription_append_only',
      'pharmacy_prescription_line_append_only',
      'pharmacy_prescription_fill_append_only',
    ])
      expect(sql).toContain(trigger);
  });
  it('serializes cumulative fill validation and rejects quantity/repeat overflow', () => {
    expect(sql).toContain('FOR UPDATE OF l');
    expect(sql).toContain('fill exceeds remaining authorized quantity');
    expect(sql).toContain('fill exceeds authorized repeats');
  });
  it('routes prescription procedures through pharmacy-dispensing', () => {
    expect(moduleForProcedure('pharmacyPrescriptions.capture')).toBe('pharmacy-dispensing');
  });
});
