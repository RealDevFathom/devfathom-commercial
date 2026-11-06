import { describe, expect, it } from 'vitest';

import { stepBlockers, type SopOccurrence, type SopOccurrenceStep } from './sop-model';

/**
 * DEV-751 (Codex P2 on #1418): on a procedure without a separate excursion step
 * (opening, closing), an out-of-range reading is documented on the temperature
 * step's own note. A done step can't be edited later, so the runner must ask
 * for that note before the step can be marked done.
 */
const OUT_OF_RANGE = 'A linked reading is out of range. Write what happened and what you did.';

function occurrence(opts: { outOfRange?: boolean; linkNote?: string | null; titles?: string[] }): {
  occ: SopOccurrence;
  step: SopOccurrenceStep;
} {
  const titles = opts.titles ?? ['Confirm readings', 'Open the counter'];
  const steps = titles.map((title, index) => ({
    id: `ostep_${index + 1}`,
    title,
    stepOrder: index + 1,
    completed: false,
    requiresNote: false,
    requiresPhoto: false,
    requiresSignature: false,
    requiredRecordType: index === 0 ? 'TEMPERATURE_LOG' : null,
  }));
  const occ = {
    steps,
    evidence: [],
    recordLinks: [
      {
        occurrenceStepId: 'ostep_1',
        recordType: 'TEMPERATURE_LOG',
        recordId: 'log_hot',
        note: opts.linkNote ?? null,
        detail: { outOfRange: opts.outOfRange ?? true },
      },
    ],
  } as unknown as SopOccurrence;
  return { occ, step: steps[0] as unknown as SopOccurrenceStep };
}

describe('stepBlockers: out-of-range reading without an excursion step', () => {
  it('asks for a note before the temperature step can be marked done', () => {
    const { occ, step } = occurrence({});
    expect(stepBlockers(occ, step, { note: '' } as never)).toContain(OUT_OF_RANGE);
    expect(stepBlockers(occ, step, { note: '   ' } as never)).toContain(OUT_OF_RANGE);
  });

  it.each([
    ['a step note', {}, 'Fridge at 9 °C; moved stock'],
    ['a note on the link', { linkNote: 'Door left open; reset' }, ''],
    ['an in-range reading', { outOfRange: false }, ''],
    ['a separate excursion step', { titles: ['Confirm readings', 'Record any excursion'] }, ''],
  ])('does not ask with %s', (_label, opts, note) => {
    const { occ, step } = occurrence(opts);
    expect(stepBlockers(occ, step, { note } as never)).not.toContain(OUT_OF_RANGE);
  });
});
