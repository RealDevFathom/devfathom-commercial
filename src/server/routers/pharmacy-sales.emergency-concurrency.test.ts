import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve('src/server/routers/pharmacy-sales.ts'), 'utf8');

describe('pharmacySales emergency controlled-supply concurrency', () => {
  it('locks the tenant, patient, and medicine before checking eligibility', () => {
    const emergencyStart = source.indexOf('if (authorization.emergency)');
    const prescriptionStart = source.indexOf(
      'if (!authorization.prescriptionLineId)',
      emergencyStart,
    );
    const emergencyPath = source.slice(emergencyStart, prescriptionStart);
    const eligibilityLock = emergencyPath.indexOf("':controlled-emergency:'");

    expect(emergencyStart).toBeGreaterThan(-1);
    expect(prescriptionStart).toBeGreaterThan(emergencyStart);
    expect(eligibilityLock).toBeGreaterThan(-1);
    expect(emergencyPath).toContain(
      "scope.organizationId + ':controlled-emergency:' + authorization.patientId + ':' + medicine.id",
    );
    expect(eligibilityLock).toBeLessThan(
      emergencyPath.indexOf('pharmacyControlledRegisterEntry.count'),
    );
    expect(eligibilityLock).toBeLessThan(
      emergencyPath.indexOf('pharmacyEmergencyRxFollowUp.findFirst'),
    );
  });
});
