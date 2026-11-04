import { afterEach, describe, expect, it } from 'vitest';

import {
  PHARMACY_SOP_EVIDENCE_FILE_PREFIX,
  isPharmacySopCapturedEvidence,
  pharmacySopEvidenceFilename,
} from './sop-evidence';

const ORIGINAL_SECRET = process.env.AUTH_SECRET;
const IDENTITY = {
  organizationId: 'org_1',
  occurrenceId: 'occ_1',
  occurrenceStepId: 'ostep_1',
  contentHash: 'a'.repeat(64),
  mimeType: 'image/png; evidence=photo',
  uploaderStaffProfileId: 'staff_1',
};

function minted() {
  const name = pharmacySopEvidenceFilename(IDENTITY, 'png');
  return {
    occurrenceId: IDENTITY.occurrenceId,
    occurrenceStepId: IDENTITY.occurrenceStepId,
    contentHash: IDENTITY.contentHash,
    mimeType: IDENTITY.mimeType,
    uploaderStaffProfileId: IDENTITY.uploaderStaffProfileId,
    storageRef: `/api/files/${name}`,
  };
}

afterEach(() => {
  process.env.AUTH_SECRET = ORIGINAL_SECRET;
});

describe('pharmacy SOP evidence provenance', () => {
  it('mints a bare, prefixed filename that verifies only for its own row', () => {
    process.env.AUTH_SECRET = 'secret-one';
    const row = minted();
    const name = row.storageRef.slice('/api/files/'.length);
    expect(name.startsWith(PHARMACY_SOP_EVIDENCE_FILE_PREFIX)).toBe(true);
    expect(name).not.toMatch(/[/\\]|\.\./);
    expect(isPharmacySopCapturedEvidence(row, 'org_1')).toBe(true);
    expect(isPharmacySopCapturedEvidence({ ...row, occurrenceId: 'occ_2' }, 'org_1')).toBe(false);
    expect(isPharmacySopCapturedEvidence({ ...row, contentHash: 'b'.repeat(64) }, 'org_1')).toBe(
      false
    );
  });

  it('rejects the restaurant naming, a bare prefix and a tampered MAC', () => {
    process.env.AUTH_SECRET = 'secret-one';
    const row = minted();
    const prefixOnly = `/api/files/${PHARMACY_SOP_EVIDENCE_FILE_PREFIX}11111111-2222-4333-8444-555555555555.png`;
    const tampered = row.storageRef.replace(/[0-9a-f](\.png)$/, (m, ext) =>
      m[0] === '0' ? `1${ext}` : `0${ext}`
    );
    for (const storageRef of [
      '/api/files/sop-11111111-2222-4333-8444-555555555555.png',
      prefixOnly,
      tampered,
      null,
    ]) {
      expect(isPharmacySopCapturedEvidence({ ...row, storageRef }, 'org_1')).toBe(false);
    }
  });

  it('fails closed without AUTH_SECRET and after the secret rotates', () => {
    process.env.AUTH_SECRET = 'secret-one';
    const row = minted();
    process.env.AUTH_SECRET = 'secret-two';
    expect(isPharmacySopCapturedEvidence(row, 'org_1')).toBe(false);
    delete process.env.AUTH_SECRET;
    expect(isPharmacySopCapturedEvidence(row, 'org_1')).toBe(false);
    expect(() => pharmacySopEvidenceFilename(IDENTITY, 'png')).toThrow(/AUTH_SECRET/);
  });
});
