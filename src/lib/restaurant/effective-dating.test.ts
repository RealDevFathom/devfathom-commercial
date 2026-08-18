import { describe, expect, it } from 'vitest';

import {
  VersionImmutabilityError,
  VersionResolutionError,
  VersionTransitionError,
  activateVersion,
  assertVersionMutable,
  isActive,
  isDraft,
  isSuperseded,
  nextVersionNumber,
  planActivation,
  resolveActiveVersion,
  resolveEffectiveVersion,
  supersedeVersion,
  type EffectiveDatedVersionRecord,
  type VersionRecord,
} from './effective-dating';

const at = new Date('2026-06-01T12:00:00.000Z');

function version(id: string, status: VersionRecord['status']): VersionRecord {
  return { id, status };
}

function dated(
  id: string,
  status: EffectiveDatedVersionRecord['status'],
  effectiveFrom: string
): EffectiveDatedVersionRecord {
  return { id, status, effectiveFrom: new Date(effectiveFrom) };
}

describe('status predicates', () => {
  it('classifies each status', () => {
    expect(isDraft(version('a', 'DRAFT'))).toBe(true);
    expect(isActive(version('a', 'ACTIVE'))).toBe(true);
    expect(isSuperseded(version('a', 'SUPERSEDED'))).toBe(true);
    expect(isDraft(version('a', 'ACTIVE'))).toBe(false);
  });
});

describe('assertVersionMutable (C3 immutability guard)', () => {
  it('allows editing a DRAFT version', () => {
    expect(() => assertVersionMutable(version('a', 'DRAFT'))).not.toThrow();
  });

  it('rejects editing an ACTIVE version', () => {
    expect(() => assertVersionMutable(version('a', 'ACTIVE'))).toThrow(VersionImmutabilityError);
    expect(() => assertVersionMutable(version('a', 'ACTIVE'))).toThrow(/immutable/);
  });

  it('rejects editing a SUPERSEDED version', () => {
    expect(() => assertVersionMutable(version('a', 'SUPERSEDED'))).toThrow(VersionImmutabilityError);
  });
});

describe('resolveActiveVersion (single-active records, e.g. recipes)', () => {
  it('returns the one ACTIVE version', () => {
    const versions = [version('a', 'SUPERSEDED'), version('b', 'ACTIVE'), version('c', 'DRAFT')];
    expect(resolveActiveVersion(versions)?.id).toBe('b');
  });

  it('returns null when no version is active', () => {
    expect(resolveActiveVersion([version('a', 'DRAFT'), version('b', 'SUPERSEDED')])).toBeNull();
    expect(resolveActiveVersion([])).toBeNull();
  });

  it('throws when more than one version is ACTIVE (defense in depth)', () => {
    expect(() => resolveActiveVersion([version('a', 'ACTIVE'), version('b', 'ACTIVE')])).toThrow(
      VersionResolutionError
    );
  });
});

describe('resolveEffectiveVersion (effective-dated records, e.g. price lists)', () => {
  const versions = [
    dated('v1', 'SUPERSEDED', '2026-01-01T00:00:00.000Z'),
    dated('v2', 'ACTIVE', '2026-05-01T00:00:00.000Z'),
    dated('v3', 'DRAFT', '2026-05-15T00:00:00.000Z'),
    dated('v4', 'ACTIVE', '2026-09-01T00:00:00.000Z'),
  ];

  it('resolves the greatest effectiveFrom <= at, ignoring DRAFT', () => {
    // At June, v2 (May) is in force; v3 is DRAFT (never in force), v4 is future.
    expect(resolveEffectiveVersion(versions, at)?.id).toBe('v2');
  });

  it('resolves a historical instant to the then-current (now superseded) version', () => {
    const past = new Date('2026-03-01T00:00:00.000Z');
    expect(resolveEffectiveVersion(versions, past)?.id).toBe('v1');
  });

  it('resolves a future-dated version once its effectiveFrom has passed', () => {
    const future = new Date('2026-10-01T00:00:00.000Z');
    expect(resolveEffectiveVersion(versions, future)?.id).toBe('v4');
  });

  it('returns null when nothing is in force yet', () => {
    const before = new Date('2025-12-01T00:00:00.000Z');
    expect(resolveEffectiveVersion(versions, before)).toBeNull();
  });

  it('never resolves to a DRAFT even if its effectiveFrom has passed', () => {
    const draftOnly = [dated('d', 'DRAFT', '2020-01-01T00:00:00.000Z')];
    expect(resolveEffectiveVersion(draftOnly, at)).toBeNull();
  });

  it('breaks effectiveFrom ties deterministically by id', () => {
    const tied = [
      dated('aaa', 'ACTIVE', '2026-05-01T00:00:00.000Z'),
      dated('bbb', 'ACTIVE', '2026-05-01T00:00:00.000Z'),
    ];
    expect(resolveEffectiveVersion(tied, at)?.id).toBe('bbb');
  });
});

describe('activateVersion (DRAFT -> ACTIVE)', () => {
  it('returns the ACTIVE patch with the server timestamp', () => {
    expect(activateVersion(version('a', 'DRAFT'), at)).toEqual({ status: 'ACTIVE', activatedAt: at });
  });

  it('rejects activating a non-DRAFT version', () => {
    expect(() => activateVersion(version('a', 'ACTIVE'), at)).toThrow(VersionTransitionError);
    expect(() => activateVersion(version('a', 'SUPERSEDED'), at)).toThrow(VersionTransitionError);
  });
});

describe('supersedeVersion (ACTIVE -> SUPERSEDED)', () => {
  it('returns the SUPERSEDED patch with the server timestamp', () => {
    expect(supersedeVersion(version('a', 'ACTIVE'), at)).toEqual({
      status: 'SUPERSEDED',
      supersededAt: at,
    });
  });

  it('rejects superseding a non-ACTIVE version', () => {
    expect(() => supersedeVersion(version('a', 'DRAFT'), at)).toThrow(VersionTransitionError);
    expect(() => supersedeVersion(version('a', 'SUPERSEDED'), at)).toThrow(VersionTransitionError);
  });
});

describe('nextVersionNumber', () => {
  it('is 1 for a record with no versions', () => {
    expect(nextVersionNumber([])).toBe(1);
  });

  it('is one past the current maximum', () => {
    expect(nextVersionNumber([{ versionNumber: 1 }, { versionNumber: 3 }, { versionNumber: 2 }])).toBe(
      4
    );
  });
});

describe('planActivation (single-active: supersede prior + activate target)', () => {
  it('supersedes the current ACTIVE and activates the target DRAFT', () => {
    const versions = [version('old', 'ACTIVE'), version('new', 'DRAFT')];
    const plan = planActivation(versions, 'new', at);
    expect(plan.activate).toEqual({ id: 'new', patch: { status: 'ACTIVE', activatedAt: at } });
    expect(plan.supersede).toEqual({ id: 'old', patch: { status: 'SUPERSEDED', supersededAt: at } });
  });

  it('activates the first version with nothing to supersede', () => {
    const plan = planActivation([version('first', 'DRAFT')], 'first', at);
    expect(plan.activate.id).toBe('first');
    expect(plan.supersede).toBeNull();
  });

  it('throws when the target is not among the versions', () => {
    expect(() => planActivation([version('a', 'DRAFT')], 'missing', at)).toThrow(
      VersionTransitionError
    );
  });

  it('throws when the target is not a DRAFT', () => {
    const versions = [version('a', 'ACTIVE')];
    expect(() => planActivation(versions, 'a', at)).toThrow(VersionTransitionError);
  });
});
