import { describe, expect, it } from 'vitest';
import {
  blankLine,
  captureBlockers,
  captureLines,
  filterRegister,
  registerStatus,
  type CaptureLineDraft,
  type CaptureReadiness,
} from './prescription-capture';

const completeLine = (overrides: Partial<CaptureLineDraft> = {}): CaptureLineDraft => ({
  ...blankLine(),
  medicineId: 'medicine-a',
  presentationId: 'presentation-a',
  quantity: '10',
  directions: 'One tablet every 8 hours',
  ...overrides,
});

const ready = (overrides: Partial<CaptureReadiness> = {}): CaptureReadiness => ({
  hasPatient: true,
  hasPrescriber: true,
  hasSourceFile: true,
  sourceError: null,
  validUntil: '2026-12-01',
  lines: [completeLine()],
  ...overrides,
});

describe('captureBlockers', () => {
  it('has nothing to report for a complete capture', () => {
    expect(captureBlockers(ready())).toEqual([]);
  });

  it('lists every missing item for an empty form in form order', () => {
    expect(
      captureBlockers({
        hasPatient: false,
        hasPrescriber: false,
        hasSourceFile: false,
        sourceError: null,
        validUntil: '',
        lines: [blankLine()],
      })
    ).toEqual([
      'Select a patient',
      'Select a prescriber',
      'Attach the prescription image',
      'Enter the valid-until date',
      'Line 1: add medicine, presentation, authorized units and directions',
    ]);
  });

  it('asks to add a patient or prescriber when the directory is empty', () => {
    expect(
      captureBlockers(
        ready({
          hasPatient: false,
          hasPrescriber: false,
          patientDirectoryEmpty: true,
          prescriberDirectoryEmpty: true,
        })
      )
    ).toEqual(['Add a patient, then select them', 'Add a prescriber, then select them']);
  });

  it('explains an invalid image instead of reporting it missing', () => {
    expect(captureBlockers(ready({ sourceError: 'Choose a file no larger than 5 MiB.' }))).toEqual([
      'Replace the prescription image: Choose a file no larger than 5 MiB.',
    ]);
  });

  it('names the incomplete line and rejects non-positive or fractional units', () => {
    expect(
      captureBlockers(
        ready({
          lines: [
            completeLine(),
            completeLine({ quantity: '0' }),
            completeLine({ quantity: '1.5', directions: '  ' }),
          ],
        })
      )
    ).toEqual(['Line 2: add authorized units', 'Line 3: add authorized units and directions']);
  });
});

describe('captureLines', () => {
  it('numbers lines in visible order and converts units', () => {
    const lines = [
      completeLine({ medicineId: 'a' }),
      completeLine({ medicineId: 'b', quantity: '3' }),
    ];
    expect(captureLines(lines)).toEqual([
      {
        lineNumber: 1,
        medicineId: 'a',
        presentationId: 'presentation-a',
        authorizedCanonicalUnits: 10,
        directions: 'One tablet every 8 hours',
      },
      {
        lineNumber: 2,
        medicineId: 'b',
        presentationId: 'presentation-a',
        authorizedCanonicalUnits: 3,
        directions: 'One tablet every 8 hours',
      },
    ]);
  });

  it('gives every new line a distinct key', () => {
    expect(blankLine().key).not.toBe(blankLine().key);
  });
});

const rx = (
  id: string,
  overrides: {
    validFrom?: string;
    validUntil?: string;
    remaining?: number[];
    patient?: string;
    prescriber?: string;
    registrationNumber?: string;
    medicines?: string[];
  } = {}
) => {
  const medicines = overrides.medicines ?? ['Amoxicillin 500mg'];
  return {
    id,
    validFrom: new Date(`${overrides.validFrom ?? '2026-10-01'}T00:00:00.000Z`),
    validUntil: new Date(`${overrides.validUntil ?? '2026-12-01'}T00:00:00.000Z`),
    patient: { displayName: overrides.patient ?? 'Ayesha Khan' },
    prescriber: {
      name: overrides.prescriber ?? 'Dr. Imran Malik',
      registrationNumber: overrides.registrationNumber ?? 'PMC-1234',
    },
    lines: medicines.map((productName, index) => ({
      remainingAuthorizedUnits: overrides.remaining?.[index] ?? 5,
      medicine: { productName },
    })),
  };
};

describe('registerStatus', () => {
  const today = '2026-11-01';

  it('derives active, expired, not-yet-valid and fully dispensed states', () => {
    expect(registerStatus(rx('a'), today)).toBe('ACTIVE');
    expect(registerStatus(rx('b', { validUntil: '2026-10-31' }), today)).toBe('EXPIRED');
    expect(registerStatus(rx('c', { validFrom: '2026-11-02' }), today)).toBe('NOT_YET_VALID');
    expect(registerStatus(rx('d', { medicines: ['A', 'B'], remaining: [0, 0] }), today)).toBe(
      'EXHAUSTED'
    );
  });

  it('keeps a prescription valid through its last calendar day', () => {
    expect(registerStatus(rx('a', { validUntil: today }), today)).toBe('ACTIVE');
  });

  it('stays active while any line has units left', () => {
    expect(registerStatus(rx('a', { medicines: ['A', 'B'], remaining: [0, 2] }), today)).toBe(
      'ACTIVE'
    );
  });
});

describe('filterRegister', () => {
  const today = '2026-11-01';
  const register = [
    rx('rx-1111', { patient: 'Ayesha Khan', prescriber: 'Dr. Imran Malik' }),
    rx('rx-2222', {
      patient: 'Bilal Ahmed',
      prescriber: 'Dr. Sara Qureshi',
      registrationNumber: 'PMC-9876',
      medicines: ['Metformin 500mg'],
      validUntil: '2026-10-15',
    }),
  ];

  it('returns everything with no filter', () => {
    expect(filterRegister(register, { query: '', status: 'ALL' }, today)).toHaveLength(2);
  });

  it.each([
    ['patient', 'bilal', 'rx-2222'],
    ['prescriber', 'imran', 'rx-1111'],
    ['registration number', 'pmc-9876', 'rx-2222'],
    ['reference', 'RX-1111', 'rx-1111'],
    ['medicine', 'metformin', 'rx-2222'],
    ['several words', 'ayesha amoxicillin', 'rx-1111'],
  ])('matches by %s, case-insensitively', (_label, query, id) => {
    expect(filterRegister(register, { query, status: 'ALL' }, today).map((r) => r.id)).toEqual([
      id,
    ]);
  });

  it('combines search with a status filter', () => {
    expect(
      filterRegister(register, { query: 'dr', status: 'EXPIRED' }, today).map((r) => r.id)
    ).toEqual(['rx-2222']);
    expect(filterRegister(register, { query: 'bilal', status: 'ACTIVE' }, today)).toEqual([]);
  });
});
