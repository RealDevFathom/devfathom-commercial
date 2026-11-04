import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PHARMACY_SOP_EVIDENCE_FILE_PREFIX,
  hasPharmacySopEvidenceName,
  isPharmacySopCapturedEvidence,
  isPharmacySopProof,
  pharmacySopEvidenceFilename,
  resolvePharmacySopProvenance,
  writePharmacySopUploadReceipt,
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

describe('pharmacy SOP provenance resolver', () => {
  function receipts(
    rows: Array<{ evidenceId: string; occurrenceId: string; contentHash: string }>
  ) {
    const findMany = vi.fn().mockResolvedValue(rows);
    return { db: { pharmacySopEvidenceCapture: { findMany } } as never, findMany };
  }
  const withId = (id: string, row: ReturnType<typeof minted>) => ({ id, ...row });

  it('classifies RECEIPT, LEGACY_HMAC, UNCONFIRMED and FOREIGN in input order', async () => {
    process.env.AUTH_SECRET = 'secret-one';
    const receipted = withId('ev_receipt', minted());
    const legacy = withId('ev_legacy', minted());
    process.env.AUTH_SECRET = 'secret-zero';
    const rotated = withId('ev_rotated', minted());
    process.env.AUTH_SECRET = 'secret-one';
    const foreign = {
      ...withId('ev_foreign', minted()),
      storageRef: '/api/files/sop-11111111-2222-4333-8444-555555555555.png',
    };
    const { db, findMany } = receipts([
      { evidenceId: 'ev_receipt', occurrenceId: 'occ_1', contentHash: receipted.contentHash },
    ]);
    await expect(
      resolvePharmacySopProvenance(db, 'org_1', [receipted, legacy, rotated, foreign])
    ).resolves.toEqual(['RECEIPT', 'LEGACY_HMAC', 'UNCONFIRMED', 'FOREIGN']);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        evidenceId: { in: ['ev_receipt', 'ev_legacy', 'ev_rotated', 'ev_foreign'] },
      },
      select: { evidenceId: true, occurrenceId: true, contentHash: true },
    });
  });

  it('keeps a receipt authoritative after rotation and with no secret at all', async () => {
    process.env.AUTH_SECRET = 'secret-one';
    const row = withId('ev_1', minted());
    const receipt = { evidenceId: 'ev_1', occurrenceId: 'occ_1', contentHash: row.contentHash };
    process.env.AUTH_SECRET = 'secret-two';
    await expect(
      resolvePharmacySopProvenance(receipts([receipt]).db, 'org_1', [row])
    ).resolves.toEqual(['RECEIPT']);
    // Without its receipt the same row is present but unconfirmed, not foreign.
    await expect(resolvePharmacySopProvenance(receipts([]).db, 'org_1', [row])).resolves.toEqual([
      'UNCONFIRMED',
    ]);
    delete process.env.AUTH_SECRET;
    await expect(
      resolvePharmacySopProvenance(receipts([receipt]).db, 'org_1', [row])
    ).resolves.toEqual(['RECEIPT']);
  });

  it('ignores a receipt for another occurrence or other bytes', async () => {
    process.env.AUTH_SECRET = 'secret-one';
    const row = {
      ...withId('ev_1', minted()),
      storageRef: '/api/files/restaurant-proof.png',
    };
    for (const receipt of [
      { evidenceId: 'ev_1', occurrenceId: 'occ_2', contentHash: row.contentHash },
      { evidenceId: 'ev_1', occurrenceId: 'occ_1', contentHash: 'c'.repeat(64) },
    ]) {
      await expect(
        resolvePharmacySopProvenance(receipts([receipt]).db, 'org_1', [row])
      ).resolves.toEqual(['FOREIGN']);
    }
  });

  it('does not query receipts when no row carries an id', async () => {
    process.env.AUTH_SECRET = 'secret-one';
    const { db, findMany } = receipts([]);
    await expect(resolvePharmacySopProvenance(db, 'org_1', [minted()])).resolves.toEqual([
      'LEGACY_HMAC',
    ]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('treats only a strict minted shape as a pharmacy-style name', () => {
    expect(hasPharmacySopEvidenceName(`/api/files/${PHARMACY_SOP_EVIDENCE_FILE_PREFIX}x.png`)).toBe(
      false
    );
    expect(hasPharmacySopEvidenceName(null)).toBe(false);
    process.env.AUTH_SECRET = 'secret-one';
    expect(hasPharmacySopEvidenceName(minted().storageRef)).toBe(true);
    expect(isPharmacySopProof('RECEIPT')).toBe(true);
    expect(isPharmacySopProof('LEGACY_HMAC')).toBe(true);
    expect(isPharmacySopProof('UNCONFIRMED')).toBe(false);
    expect(isPharmacySopProof('FOREIGN')).toBe(false);
  });

  it('writes an UPLOAD receipt idempotently', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const receipt = {
      organizationId: 'org_1',
      pharmacyBranchId: 'pbranch_1',
      occurrenceId: 'occ_1',
      evidenceId: 'ev_1',
      contentHash: 'a'.repeat(64),
      capturedByStaffProfileId: 'staff_1',
      capturedByUserId: 'user_1',
    };
    await writePharmacySopUploadReceipt(
      { pharmacySopEvidenceCapture: { createMany } } as never,
      receipt
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [{ ...receipt, source: 'UPLOAD' }],
      skipDuplicates: true,
    });
  });
});
