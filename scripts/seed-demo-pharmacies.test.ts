import { describe, expect, it } from 'vitest';
import { demoMedicineCatalog, demoPharmacyPlan, readDemoPasswords } from './seed-demo-pharmacies';

describe('demo pharmacy seed smoke test', () => {
  it('defines the solo and separated-staff fixtures with 40 batched medicines', () => {
    expect(demoPharmacyPlan.map((item) => item.mode)).toEqual(['SOLO', 'STAFFED']);
    expect(demoPharmacyPlan[1].roles).toEqual(['owner', 'pharmacist', 'cashier']);
    expect(demoMedicineCatalog).toHaveLength(40);
    expect(demoMedicineCatalog.every((item) => item.batches.length >= 2 && item.mrpPkr > 0)).toBe(
      true
    );
  });
  it('refuses to seed without every password', () => {
    expect(() => readDemoPasswords({})).toThrow(/DEMO_SOLO_OWNER_PASSWORD/);
  });
});
