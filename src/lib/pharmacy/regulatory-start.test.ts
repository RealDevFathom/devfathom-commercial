import { describe, expect, it } from 'vitest';
import { regulatoryProfileInForceWhere, regulatoryStartInstant } from './regulatory-start';

type Version = { id: string; effectiveFrom: Date; effectiveTo: Date | null };

/** Evaluates the filter the way PostgreSQL would for these two columns. */
function inForce(where: ReturnType<typeof regulatoryProfileInForceWhere>, version: Version) {
  if (!(version.effectiveFrom <= where.effectiveFrom.lte)) return false;
  return where.OR.some((clause) =>
    'gt' in (clause.effectiveTo ?? {})
      ? version.effectiveTo !== null && version.effectiveTo > clause.effectiveTo!.gt
      : version.effectiveTo === null
  );
}

const KARACHI = 'Asia/Karachi';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
// v1 is closed by v2, saved effective 21 Oct; v2 is closed by v3, saved effective 22 Oct.
const versions: Version[] = [
  { id: 'v1', effectiveFrom: day('2026-01-01'), effectiveTo: day('2026-10-21') },
  { id: 'v2', effectiveFrom: day('2026-10-21'), effectiveTo: day('2026-10-22') },
  { id: 'v3', effectiveFrom: day('2026-10-22'), effectiveTo: null },
];
const pick = (at: Date, timeZone?: string | null) =>
  versions
    .filter((version) => inForce(regulatoryProfileInForceWhere(at, timeZone), version))
    .map((version) => version.id);

describe('regulatoryProfileInForceWhere (DEV-298)', () => {
  it('selects the version dated today from 00:30 PKT on its start day', () => {
    expect(pick(new Date('2026-10-20T19:30:00.000Z'), KARACHI)).toEqual(['v2']);
  });

  it('keeps the previous version until PKT midnight', () => {
    expect(pick(new Date('2026-10-20T18:59:59.999Z'), KARACHI)).toEqual(['v1']);
  });

  it('ends a version at the PKT midnight its successor starts (expiry boundary)', () => {
    expect(pick(new Date('2026-10-21T18:59:59.999Z'), KARACHI)).toEqual(['v2']);
    expect(pick(new Date('2026-10-21T19:00:00.000Z'), KARACHI)).toEqual(['v3']);
  });

  it('is unchanged for a UTC workspace', () => {
    expect(pick(new Date('2026-10-20T19:30:00.000Z'), 'UTC')).toEqual(['v1']);
    expect(pick(new Date('2026-10-20T19:30:00.000Z'), null)).toEqual(['v1']);
    expect(pick(new Date('2026-10-21T00:00:00.000Z'), 'UTC')).toEqual(['v2']);
  });

  it('never moves a start earlier than the instant for zones behind UTC', () => {
    const at = new Date('2026-10-21T02:00:00.000Z');
    expect(regulatoryStartInstant(at, 'America/New_York')).toEqual(at);
  });
});
