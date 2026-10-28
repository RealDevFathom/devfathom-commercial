import { describe, expect, it } from 'vitest';
import { hasAttachedRxReference } from './rx-line-status';

describe('#341 / #620 deferred prescription reference display', () => {
  it('accepts the two persisted validated reference IDs without an early fill', () => {
    expect(
      hasAttachedRxReference({
        prescriptionLineId: 'rx-line-a',
        prescriptionPatientId: 'patient-a',
      })
    ).toBe(true);
  });

  it.each([
    {},
    { prescriptionLineId: 'rx-line-a' },
    { prescriptionPatientId: 'patient-a' },
    { prescriptionLineId: null, prescriptionPatientId: 'patient-a' },
    { prescriptionLineId: 'rx-line-a', prescriptionPatientId: null },
    { prescriptionLineId: '', prescriptionPatientId: 'patient-a' },
    { prescriptionLineId: 'rx-line-a', prescriptionPatientId: '' },
  ])('does not clear the missing-reference flag for an incomplete reference: %j', (line) => {
    expect(hasAttachedRxReference(line)).toBe(false);
  });
});
