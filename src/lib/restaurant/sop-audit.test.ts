/**
 * WHA-226 — immutable SOP audit history unit tests.
 *
 * Covers: the fold over the four append-only sources, actor/action/proof
 * references, the total ordering that makes a trail citable, the declared claim
 * seam, and the fact that reading a trail writes nothing.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  buildAuditTrail,
  getOccurrenceAuditTrail,
  orderAuditEntries,
  type SopAuditSources,
} from './sop-audit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const T = (iso: string) => new Date(iso);

function sources(over: Partial<SopAuditSources> = {}): SopAuditSources {
  return { steps: [], evidence: [], verifications: [], escalationEvents: [], ...over };
}

describe('buildAuditTrail', () => {
  it('folds all four sources into one ordered trail', () => {
    const trail = buildAuditTrail(
      'occ_1',
      sources({
        steps: [
          {
            id: 'step_1',
            completed: true,
            completedAt: T('2026-08-20T09:00:00.000Z'),
            completedByStaffProfileId: 'staff_a',
            completedBy: { displayName: 'Ana' },
            templateStep: { title: 'Check walk-in temperature' },
          },
        ],
        evidence: [
          {
            id: 'ev_1',
            contentHash: 'sha256:abc',
            storageRef: 's3://bucket/ev_1',
            mimeType: 'image/jpeg',
            capturedAt: T('2026-08-20T09:05:00.000Z'),
            uploaderStaffProfileId: 'staff_a',
            uploader: { displayName: 'Ana' },
          },
        ],
        escalationEvents: [
          {
            id: 'esc_1',
            kind: 'FIRED',
            detail: 'Step 1 fired to manager via IN_APP.',
            createdAt: T('2026-08-20T13:00:00.000Z'),
            escalationStepId: 'estep_1',
            escalationStep: { stepOrder: 1 },
            actorStaffProfileId: null,
            actor: null,
          },
        ],
        verifications: [
          {
            id: 'ver_1',
            action: 'VERIFY',
            reason: 'Looks good',
            createdAt: T('2026-08-20T14:00:00.000Z'),
            coAuthorizationId: null,
            actorStaffProfileId: 'staff_m',
            actor: { displayName: 'Mo' },
          },
        ],
      })
    );

    expect(trail.map((e) => e.action)).toEqual([
      'STEP_COMPLETED',
      'EVIDENCE_CAPTURED',
      'ESCALATION_FIRED',
      'VERIFIED',
    ]);
    expect(trail.every((e) => e.occurrenceId === 'occ_1')).toBe(true);
  });

  it('carries actor identity, including the null actor of a system escalation', () => {
    const trail = buildAuditTrail(
      'occ_1',
      sources({
        escalationEvents: [
          {
            id: 'esc_1',
            kind: 'FIRED',
            detail: null,
            createdAt: T('2026-08-20T13:00:00.000Z'),
            escalationStepId: 'estep_1',
            escalationStep: { stepOrder: 2 },
            actorStaffProfileId: null,
            actor: null,
          },
        ],
      })
    );
    // System-fired escalations legitimately have no actor; the entry must still
    // exist rather than be dropped for lacking one.
    expect(trail).toHaveLength(1);
    expect(trail[0].actorStaffProfileId).toBeNull();
    expect(trail[0].actorName).toBeNull();
  });

  it('references the proof behind each act', () => {
    const trail = buildAuditTrail(
      'occ_1',
      sources({
        evidence: [
          {
            id: 'ev_1',
            contentHash: 'sha256:abc',
            storageRef: null,
            mimeType: 'image/png',
            capturedAt: T('2026-08-20T09:00:00.000Z'),
            uploaderStaffProfileId: 'staff_a',
            uploader: { displayName: 'Ana' },
          },
        ],
        verifications: [
          {
            id: 'ver_1',
            action: 'WAIVE',
            reason: 'Equipment outage',
            createdAt: T('2026-08-20T10:00:00.000Z'),
            coAuthorizationId: 'coauth_1',
            actorStaffProfileId: 'staff_m',
            actor: { displayName: 'Mo' },
          },
        ],
        escalationEvents: [
          {
            id: 'esc_1',
            kind: 'STOPPED',
            detail: 'Acknowledged; escalation halted.',
            createdAt: T('2026-08-20T11:00:00.000Z'),
            escalationStepId: null,
            escalationStep: null,
            actorStaffProfileId: null,
            actor: null,
          },
        ],
      })
    );

    expect(trail[0].proofRef).toEqual({
      kind: 'EVIDENCE',
      evidenceId: 'ev_1',
      contentHash: 'sha256:abc',
      storageRef: null,
    });
    // A waiver's authorization is the proof it was permitted at all.
    expect(trail[1].proofRef).toEqual({ kind: 'CO_AUTHORIZATION', coAuthorizationId: 'coauth_1' });
    // A STOPPED event has no firing step, so it has nothing to reference.
    expect(trail[2].proofRef).toBeNull();
  });

  it('declares the claim seam as null on every entry', () => {
    // The claim model is not on the schema at this base; the field is the
    // declared seam rather than an invented reference.
    const trail = buildAuditTrail(
      'occ_1',
      sources({
        steps: [
          {
            id: 'step_1',
            completed: true,
            completedAt: T('2026-08-20T09:00:00.000Z'),
            completedByStaffProfileId: 'staff_a',
            completedBy: { displayName: 'Ana' },
            templateStep: { title: 'Step' },
          },
        ],
      })
    );
    expect(trail[0].claimRef).toBeNull();
  });

  it('omits steps that were never completed or carry no instant', () => {
    const trail = buildAuditTrail(
      'occ_1',
      sources({
        steps: [
          {
            id: 'step_incomplete',
            completed: false,
            completedAt: null,
            completedByStaffProfileId: null,
            completedBy: null,
            templateStep: { title: 'Not done' },
          },
          {
            id: 'step_no_instant',
            completed: true,
            completedAt: null,
            completedByStaffProfileId: 'staff_a',
            completedBy: { displayName: 'Ana' },
            templateStep: { title: 'No instant' },
          },
        ],
      })
    );
    // An act with no recorded instant cannot be placed in the order, and an
    // incomplete step is not an act at all.
    expect(trail).toEqual([]);
  });

  it('ignores source rows with an unrecognised kind rather than emitting a blank entry', () => {
    const trail = buildAuditTrail(
      'occ_1',
      sources({
        verifications: [
          {
            id: 'ver_x',
            action: 'NOT_A_REAL_ACTION',
            reason: null,
            createdAt: T('2026-08-20T10:00:00.000Z'),
            coAuthorizationId: null,
            actorStaffProfileId: null,
            actor: null,
          },
        ],
      })
    );
    expect(trail).toEqual([]);
  });
});

describe('orderAuditEntries', () => {
  it('is a total order — entries sharing an instant never reshuffle', () => {
    // A verification and its status change are written in one transaction with
    // the same `now`, so shared timestamps are routine, not an edge case.
    const same = T('2026-08-20T10:00:00.000Z');
    const built = () =>
      buildAuditTrail(
        'occ_1',
        sources({
          steps: [
            {
              id: 'step_1',
              completed: true,
              completedAt: same,
              completedByStaffProfileId: 'staff_a',
              completedBy: { displayName: 'Ana' },
              templateStep: { title: 'Step' },
            },
          ],
          evidence: [
            {
              id: 'ev_1',
              contentHash: 'sha256:abc',
              storageRef: null,
              mimeType: 'image/png',
              capturedAt: same,
              uploaderStaffProfileId: 'staff_a',
              uploader: { displayName: 'Ana' },
            },
          ],
          verifications: [
            {
              id: 'ver_1',
              action: 'VERIFY',
              reason: null,
              createdAt: same,
              coAuthorizationId: null,
              actorStaffProfileId: 'staff_m',
              actor: { displayName: 'Mo' },
            },
          ],
        })
      );

    expect(built().map((e) => e.action)).toEqual([
      'STEP_COMPLETED',
      'EVIDENCE_CAPTURED',
      'VERIFIED',
    ]);
    expect(built()).toEqual(built());
  });

  it('breaks a same-instant same-action tie by id', () => {
    const same = T('2026-08-20T10:00:00.000Z');
    const entries = ['b_id', 'a_id'].map((id) => ({
      id,
      occurrenceId: 'occ_1',
      action: 'STEP_COMPLETED' as const,
      at: same,
      actorStaffProfileId: null,
      actorName: null,
      proofRef: null,
      claimRef: null as null,
      detail: null,
    }));
    expect(orderAuditEntries(entries).map((e) => e.id)).toEqual(['a_id', 'b_id']);
    expect(orderAuditEntries([...entries].reverse()).map((e) => e.id)).toEqual(['a_id', 'b_id']);
  });

  it('does not mutate its input', () => {
    const same = T('2026-08-20T10:00:00.000Z');
    const entries = ['b_id', 'a_id'].map((id) => ({
      id,
      occurrenceId: 'occ_1',
      action: 'STEP_COMPLETED' as const,
      at: same,
      actorStaffProfileId: null,
      actorName: null,
      proofRef: null,
      claimRef: null as null,
      detail: null,
    }));
    orderAuditEntries(entries);
    expect(entries.map((e) => e.id)).toEqual(['b_id', 'a_id']);
  });
});

describe('getOccurrenceAuditTrail', () => {
  function makeDb(result: unknown) {
    const findUnique = vi.fn().mockResolvedValue(result);
    const db = {
      restaurantSopOccurrence: { findUnique },
    } as unknown as ScopedDb;
    return { db, findUnique };
  }

  it('returns null for an occurrence RLS does not resolve', () => {
    // Out-of-tenant / out-of-branch rows must not yield a partial trail.
    const { db } = makeDb(null);
    return expect(getOccurrenceAuditTrail(db, 'occ_missing')).resolves.toBeNull();
  });

  it('reads only — the trail is derived, never written', async () => {
    const { db, findUnique } = makeDb({
      id: 'occ_1',
      steps: [],
      evidence: [],
      verifications: [],
      escalationEvents: [],
    });
    // No create/update/delete surface is touched: any write here would be a
    // second, drift-prone copy of history.
    const trail = await getOccurrenceAuditTrail(db, 'occ_1');
    expect(trail).toEqual([]);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(Object.keys(db.restaurantSopOccurrence)).toEqual(['findUnique']);
  });
});
