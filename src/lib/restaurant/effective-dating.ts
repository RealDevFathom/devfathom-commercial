import 'server-only';

/**
 * M3-L1 / C3 — effective-dating & version-immutability primitives.
 *
 * These are the shared, load-bearing primitives for the DRAFT -> ACTIVE ->
 * SUPERSEDED version lifecycle that both L2 (recipe versions) and L3
 * (price-list versions) build on. They live in L1 because they are the ONLY
 * sanctioned way those lanes resolve, activate, supersede, and mutate a
 * versioned record: a version is editable only while DRAFT, activation makes it
 * immutable, and a superseded version stays readable forever (GOV-2).
 *
 * The module performs no I/O. Resolution takes the caller-loaded versions and
 * returns the winning row; the transition helpers validate the current state
 * and return the exact field patch the caller persists (the server supplies the
 * transition timestamp — client time is untrusted). Keeping this pure keeps the
 * immutability rule in one testable place rather than re-implemented per lane.
 *
 * `VersionStatus` mirrors the Prisma `RestaurantVersionStatus` enum
 * ('DRAFT' | 'ACTIVE' | 'SUPERSEDED'); it is declared locally so the primitive
 * stays independent of the generated client and trivially unit-testable.
 */

export type VersionStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';

export const VERSION_STATUS = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  SUPERSEDED: 'SUPERSEDED',
} as const satisfies Record<VersionStatus, VersionStatus>;

/** The minimal shape every versioned record shares. */
export type VersionRecord = {
  id: string;
  status: VersionStatus;
};

/**
 * An effective-dated version (price-list versions): its in-force window starts
 * at `effectiveFrom` and ends when a later version takes effect. DRAFT versions
 * are never in force regardless of their `effectiveFrom`.
 */
export type EffectiveDatedVersionRecord = VersionRecord & {
  effectiveFrom: Date;
};

/** The field patch that persists a status transition. `activatedAt`/
 * `supersededAt` map to the nullable columns on the version tables. */
export type ActivationPatch = {
  status: Extract<VersionStatus, 'ACTIVE'>;
  activatedAt: Date;
};

export type SupersessionPatch = {
  status: Extract<VersionStatus, 'SUPERSEDED'>;
  supersededAt: Date;
};

/** Raised when a caller tries to mutate a version that is not DRAFT (C3). */
export class VersionImmutabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionImmutabilityError';
  }
}

/** Raised on an illegal status transition (e.g. activating a SUPERSEDED row). */
export class VersionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionTransitionError';
  }
}

/** Raised when the version set violates an invariant (e.g. two ACTIVE rows). */
export class VersionResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionResolutionError';
  }
}

export function isDraft(version: VersionRecord): boolean {
  return version.status === 'DRAFT';
}

export function isActive(version: VersionRecord): boolean {
  return version.status === 'ACTIVE';
}

export function isSuperseded(version: VersionRecord): boolean {
  return version.status === 'SUPERSEDED';
}

/**
 * C3 immutability guard. Throws `VersionImmutabilityError` unless the version is
 * DRAFT. Every edit to a version — or to its owned lines/entries — must call
 * this first: an ACTIVE version is frozen, and a SUPERSEDED version is history.
 * Editing a non-DRAFT version is done by forking a new DRAFT, never in place.
 */
export function assertVersionMutable(version: VersionRecord): void {
  if (version.status !== 'DRAFT') {
    throw new VersionImmutabilityError(
      `Version ${version.id} is ${version.status} and is immutable; fork a new DRAFT version instead of editing it in place.`
    );
  }
}

/**
 * Resolve the single ACTIVE version of a non-effective-dated record (a recipe).
 * Returns the ACTIVE version or `null` when none is active yet. Throws
 * `VersionResolutionError` if more than one version is ACTIVE — a defense in
 * depth beyond the one-ACTIVE-per-recipe partial unique index.
 */
export function resolveActiveVersion<T extends VersionRecord>(
  versions: readonly T[]
): T | null {
  const active = versions.filter((version) => version.status === 'ACTIVE');
  if (active.length > 1) {
    throw new VersionResolutionError(
      `Expected at most one ACTIVE version, found ${active.length}.`
    );
  }
  return active[0] ?? null;
}

/**
 * Resolve the version in force at instant `at` for an effective-dated record (a
 * price list). The winner is the non-DRAFT version with the greatest
 * `effectiveFrom` that is `<= at`; DRAFT versions are never in force. Because
 * SUPERSEDED versions stay readable, this resolves both the current price and a
 * historical price at a past instant. Returns `null` when nothing is yet in
 * force at `at`. Ties on `effectiveFrom` are broken deterministically by `id`.
 */
export function resolveEffectiveVersion<T extends EffectiveDatedVersionRecord>(
  versions: readonly T[],
  at: Date
): T | null {
  const inForce = versions.filter(
    (version) => version.status !== 'DRAFT' && version.effectiveFrom.getTime() <= at.getTime()
  );
  if (inForce.length === 0) return null;
  return inForce.reduce((winner, candidate) => {
    const delta = candidate.effectiveFrom.getTime() - winner.effectiveFrom.getTime();
    if (delta > 0) return candidate;
    if (delta === 0 && candidate.id > winner.id) return candidate;
    return winner;
  });
}

/**
 * DRAFT -> ACTIVE transition. Guards that the version is currently DRAFT and
 * returns the patch the caller persists. `at` is the server-supplied activation
 * time.
 */
export function activateVersion(version: VersionRecord, at: Date): ActivationPatch {
  if (version.status !== 'DRAFT') {
    throw new VersionTransitionError(
      `Only a DRAFT version can be activated; version ${version.id} is ${version.status}.`
    );
  }
  return { status: 'ACTIVE', activatedAt: at };
}

/**
 * ACTIVE -> SUPERSEDED transition. Guards that the version is currently ACTIVE
 * and returns the patch the caller persists. A superseded version remains
 * readable forever (GOV-2); it is never deleted.
 */
export function supersedeVersion(version: VersionRecord, at: Date): SupersessionPatch {
  if (version.status !== 'ACTIVE') {
    throw new VersionTransitionError(
      `Only an ACTIVE version can be superseded; version ${version.id} is ${version.status}.`
    );
  }
  return { status: 'SUPERSEDED', supersededAt: at };
}

/** The next monotonic version number for a record: one past the current max
 * (versions start at 1). Used when forking a new DRAFT. */
export function nextVersionNumber(
  versions: readonly { versionNumber: number }[]
): number {
  return versions.reduce((max, version) => Math.max(max, version.versionNumber), 0) + 1;
}

/** The concrete transitions to persist when activating `targetId` among a
 * record's versions. */
export type ActivationPlan = {
  activate: { id: string; patch: ActivationPatch };
  /** The prior ACTIVE version to supersede, if any (single-active records). */
  supersede: { id: string; patch: SupersessionPatch } | null;
};

/**
 * Plan the activation of DRAFT version `targetId` for a single-active record (a
 * recipe): supersede the currently ACTIVE version (if any) and activate the
 * target. This encodes the load-bearing GOV-2 rule that activating a new
 * version supersedes — never mutates — the prior one, so the two writes are
 * always applied together in one transaction. Throws if the target is not a
 * DRAFT member of `versions`.
 */
export function planActivation<T extends VersionRecord>(
  versions: readonly T[],
  targetId: string,
  at: Date
): ActivationPlan {
  const target = versions.find((version) => version.id === targetId);
  if (!target) {
    throw new VersionTransitionError(`Version ${targetId} is not among the record's versions.`);
  }
  const current = resolveActiveVersion(versions);
  return {
    activate: { id: target.id, patch: activateVersion(target, at) },
    supersede:
      current && current.id !== target.id
        ? { id: current.id, patch: supersedeVersion(current, at) }
        : null,
  };
}
