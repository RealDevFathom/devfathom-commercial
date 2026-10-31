import { describe, expect, it } from 'vitest';
import {
  belongsToVisit,
  effectiveUnknownProbability,
  estimatedLossPkr,
  outcomeLossProbability,
  WILL_RETURN_WINDOW_MS,
} from './lost-sales';

describe('lost-sales loss math', () => {
  it.each([
    ['SUBSTITUTE_TAKEN', 0],
    ['ORDERED_FOR_CUSTOMER', 0],
    ['WENT_ELSEWHERE', 1],
    ['UNKNOWN', 0.43],
  ] as const)('prices %s at its probability', (outcome, expected) => {
    expect(outcomeLossProbability(outcome, { unknownProbability: 0.43 })).toBe(expected);
    expect(estimatedLossPkr(3, 100, expected)).toBe(300 * expected);
  });

  it('flips will-return demand only after seven days without a matching sale', () => {
    const capturedAt = new Date('2026-01-01T00:00:00Z');
    expect(
      outcomeLossProbability('WILL_RETURN', {
        capturedAt,
        now: new Date(capturedAt.getTime() + WILL_RETURN_WINDOW_MS - 1),
        unknownProbability: 0.43,
      })
    ).toBe(0);
    expect(
      outcomeLossProbability('WILL_RETURN', {
        capturedAt,
        now: new Date(capturedAt.getTime() + WILL_RETURN_WINDOW_MS),
        matchingSaleFound: false,
        unknownProbability: 0.43,
      })
    ).toBe(1);
    expect(
      outcomeLossProbability('WILL_RETURN', {
        capturedAt,
        now: new Date(capturedAt.getTime() + WILL_RETURN_WINDOW_MS),
        matchingSaleFound: true,
        unknownProbability: 0.43,
      })
    ).toBe(0);
  });

  it('switches from the configured estimate at 200 known outcomes', () => {
    expect(
      effectiveUnknownProbability({
        configuredEstimate: 0.43,
        knownOutcomes: 199,
        knownLostOutcomes: 100,
      })
    ).toBe(0.43);
    expect(
      effectiveUnknownProbability({
        configuredEstimate: 0.43,
        knownOutcomes: 200,
        knownLostOutcomes: 80,
      })
    ).toBe(0.4);
  });
});

describe('lost-sales visit grouping', () => {
  const createdAt = new Date('2026-01-01T12:00:00Z');
  it('groups the same terminal and customer inside ten minutes', () => {
    expect(
      belongsToVisit(
        { terminalId: 't1', customerId: 'c1', createdAt },
        { terminalId: 't1', customerId: 'c1', createdAt: new Date(createdAt.getTime() + 599_999) }
      )
    ).toBe(true);
  });
  it('splits visits by terminal, customer, or elapsed window', () => {
    expect(
      belongsToVisit(
        { terminalId: 't1', customerId: 'c1', createdAt },
        { terminalId: 't2', customerId: 'c1', createdAt }
      )
    ).toBe(false);
    expect(
      belongsToVisit(
        { terminalId: 't1', customerId: 'c1', createdAt },
        { terminalId: 't1', customerId: 'c2', createdAt }
      )
    ).toBe(false);
    expect(
      belongsToVisit(
        { terminalId: 't1', customerId: 'c1', createdAt },
        { terminalId: 't1', customerId: 'c1', createdAt: new Date(createdAt.getTime() + 600_001) }
      )
    ).toBe(false);
  });
});
