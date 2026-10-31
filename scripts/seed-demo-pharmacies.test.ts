import { describe, expect, it } from 'vitest';
import {
  assertDemoSeedNotProduction,
  demoMedicineCatalog,
  demoPharmacyPlan,
  readDemoPasswords,
} from './seed-demo-pharmacies';

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
  it('refuses production deployments and production databases', () => {
    for (const env of [
      { DEPLOY_ENV: 'production' },
      { DEPLOY_ENV: 'prod' },
      { NODE_ENV: 'production' },
      { DATABASE_URL: 'postgresql://app@db.prod.example.internal:5432/devfathom' },
      { DATABASE_URL: 'postgresql://app@localhost:5432/devfathom_production' },
    ])
      expect(() => assertDemoSeedNotProduction(env as NodeJS.ProcessEnv)).toThrow(
        /Refusing to seed demo pharmacies/
      );
  });
  it('allows local, test and staging targets', () => {
    for (const env of [
      { NODE_ENV: 'test' },
      { NODE_ENV: 'production', DEPLOY_ENV: 'staging' },
      { DATABASE_URL: 'postgresql://app@localhost:5432/devfathom_test' },
    ])
      expect(() => assertDemoSeedNotProduction(env as NodeJS.ProcessEnv)).not.toThrow();
  });
});
