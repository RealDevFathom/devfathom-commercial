import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

import { recordAudit } from '@/server/audit';
import {
  assertClinicalDetailPurpose,
  auditPatientRead,
  hasActiveConsent,
  maskCnic,
  maskPhone,
} from './patient-prescriptions';

describe('RX-01 protected patient identity and consent', () => {
  it('masks patient identifiers', () => {
    expect(maskCnic('35202-1234567-1')).toBe('*********5671');
    expect(maskPhone('03001234567')).toBe('*******4567');
  });

  it('resolves consent independently by purpose and channel from the latest version', () => {
    const events = [
      { purpose: 'MARKETING' as const, channel: 'SMS', version: 1, granted: true },
      { purpose: 'MARKETING' as const, channel: 'SMS', version: 2, granted: false },
      { purpose: 'DISPENSING' as const, channel: 'SMS', version: 1, granted: true },
    ];
    expect(hasActiveConsent(events, 'MARKETING', 'SMS')).toBe(false);
    expect(hasActiveConsent(events, 'DISPENSING', 'SMS')).toBe(true);
  });

  it('audits both a sensitive read and an export without identifiers in metadata', () => {
    auditPatientRead({ organizationId: 'org', actorId: 'user', patientId: 'patient' });
    auditPatientRead({
      organizationId: 'org',
      actorId: 'user',
      patientId: 'patient',
      export: true,
    });
    expect(recordAudit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: 'pharmacy.patient.read', operation: 'READ' })
    );
    expect(recordAudit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: 'pharmacy.patient.export', operation: 'READ' })
    );
    expect(JSON.stringify(vi.mocked(recordAudit).mock.calls)).not.toContain('cnic');
  });
});

describe('invariant 21', () => {
  it.each(['PRESCRIPTION', 'CONDITION', 'ALLERGY', 'MEDICINE'] as const)(
    'refuses %s detail for marketing',
    (detail) => {
      expect(() => assertClinicalDetailPurpose('MARKETING', detail)).toThrow(/cannot be exposed/);
    }
  );
  it('permits prescription detail only for clinical use', () => {
    expect(() => assertClinicalDetailPurpose('DISPENSING', 'PRESCRIPTION')).not.toThrow();
  });
});
