import { describe, expect, it } from 'vitest';

import { PROVENANCE_LABEL, provenanceReviewNote, provenanceTone } from './sop-model';
import { historyEntries } from './sop-runner';
import type { SopOccurrence } from './sop-model';

/** DEV-751 — proof provenance in plain words; present proof is never "missing". */
describe('pharmacy SOP proof provenance copy', () => {
  it('names every class in plain words and never as missing or absent', () => {
    expect(PROVENANCE_LABEL).toEqual({
      RECEIPT: 'Captured here',
      LEGACY_HMAC: 'Captured here (older proof)',
      UNCONFIRMED: 'Proof present, capture not confirmed',
      FOREIGN: 'Added outside the pharmacy workspace',
    });
    for (const label of Object.values(PROVENANCE_LABEL)) {
      expect(label).not.toMatch(/missing|absent|no proof|not found/i);
    }
    expect(provenanceTone('RECEIPT')).toBe('success');
    expect(provenanceTone('LEGACY_HMAC')).toBe('success');
    expect(provenanceTone('UNCONFIRMED')).toBe('warning');
    expect(provenanceTone('FOREIGN')).toBe('danger');
  });

  it('tells a reviewer why proof cannot be accepted yet, and what to do', () => {
    expect(provenanceReviewNote([{ provenance: 'RECEIPT' }, { provenance: 'LEGACY_HMAC' }])).toBe(
      null
    );
    const unconfirmed = provenanceReviewNote([
      { provenance: 'RECEIPT' },
      { provenance: 'UNCONFIRMED' },
    ]);
    expect(unconfirmed).toContain('One proof is present');
    expect(unconfirmed).toContain('legacy receipt backfill');
    expect(unconfirmed).not.toMatch(/missing/i);
    expect(
      provenanceReviewNote([{ provenance: 'UNCONFIRMED' }, { provenance: 'UNCONFIRMED' }])
    ).toContain('2 proofs are present');
    // Foreign proof takes precedence: it can never be confirmed by a backfill.
    expect(
      provenanceReviewNote([{ provenance: 'UNCONFIRMED' }, { provenance: 'FOREIGN' }])
    ).toContain('added outside the pharmacy workspace');
  });

  it('carries provenance onto each proof entry in the history', () => {
    const occurrence = {
      id: 'occ-1',
      steps: [{ id: 'step-1', stepOrder: 1, title: 'Check fridge' }],
      evidence: [
        {
          id: 'ev-1',
          occurrenceStepId: 'step-1',
          mimeType: 'image/png; evidence=photo',
          storageRef: '/api/files/pharmacy-sop-1.png',
          provenance: 'UNCONFIRMED',
          capturedInPharmacy: false,
        },
      ],
      auditTrail: [
        {
          id: 'ev-1',
          action: 'EVIDENCE_CAPTURED',
          at: new Date('2026-11-04T04:20:00Z'),
          actorName: 'Asma',
          proofRef: { kind: 'EVIDENCE', evidenceId: 'ev-1' },
        },
        { id: 'step-1', action: 'STEP_COMPLETED', at: new Date(), actorName: 'Asma' },
      ],
      verifications: [],
      claimedAt: null,
      startedAt: null,
      submittedAt: null,
    } as unknown as SopOccurrence;
    const entries = historyEntries(occurrence);
    const proof = entries.find((entry) => entry.id === 'ev-1')!;
    expect(proof).toMatchObject({ label: 'Photo added', provenance: 'UNCONFIRMED' });
    // An unconfirmed row keeps its link but is not inlined as an image.
    expect(proof.proof).toMatchObject({ href: '/api/files/pharmacy-sop-1.png', image: false });
    expect(entries.find((entry) => entry.id === 'step-1')!.provenance).toBeNull();
  });
});
