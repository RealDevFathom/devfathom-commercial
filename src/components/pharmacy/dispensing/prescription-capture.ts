/** Matches the `capture` input contract: one to thirty lines per prescription. */
export const maxPrescriptionLines = 30;

export type CaptureLineDraft = {
  key: string;
  medicineId: string;
  presentationId: string;
  quantity: string;
  directions: string;
};

let lineKeySeed = 0;

export function blankLine(): CaptureLineDraft {
  lineKeySeed += 1;
  return {
    key: `line-${lineKeySeed}`,
    medicineId: '',
    presentationId: '',
    quantity: '',
    directions: '',
  };
}

export type CaptureReadiness = {
  hasPatient: boolean;
  hasPrescriber: boolean;
  /** No patients exist in this workspace yet. */
  patientDirectoryEmpty?: boolean;
  /** No prescribers exist in this workspace yet. */
  prescriberDirectoryEmpty?: boolean;
  hasSourceFile: boolean;
  sourceError: string | null;
  validUntil: string;
  lines: readonly CaptureLineDraft[];
};

function positiveInteger(value: string) {
  const parsed = Number(value);
  return value.trim() !== '' && Number.isSafeInteger(parsed) && parsed > 0;
}

/** Every item still missing before a prescription can be captured, in form order. */
export function captureBlockers(input: CaptureReadiness): string[] {
  const blockers: string[] = [];
  if (!input.hasPatient)
    blockers.push(
      input.patientDirectoryEmpty ? 'Add a patient, then select them' : 'Select a patient'
    );
  if (!input.hasPrescriber)
    blockers.push(
      input.prescriberDirectoryEmpty ? 'Add a prescriber, then select them' : 'Select a prescriber'
    );
  if (input.sourceError && input.hasSourceFile)
    blockers.push(`Replace the prescription image: ${input.sourceError}`);
  else if (!input.hasSourceFile) blockers.push('Attach the prescription image');
  if (!input.validUntil) blockers.push('Enter the valid-until date');
  input.lines.forEach((line, index) => {
    const missing: string[] = [];
    if (!line.medicineId) missing.push('medicine');
    if (!line.presentationId) missing.push('presentation');
    if (!positiveInteger(line.quantity)) missing.push('authorized units');
    if (!line.directions.trim()) missing.push('directions');
    if (missing.length) blockers.push(`Line ${index + 1}: add ${joinList(missing)}`);
  });
  return blockers;
}

function joinList(items: readonly string[]) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Map completed drafts to the server's line shape; numbering follows the visible order. */
export function captureLines(lines: readonly CaptureLineDraft[]) {
  return lines.map((line, index) => ({
    lineNumber: index + 1,
    medicineId: line.medicineId,
    presentationId: line.presentationId,
    authorizedCanonicalUnits: Number(line.quantity),
    directions: line.directions,
  }));
}

export type RegisterStatus = 'ACTIVE' | 'NOT_YET_VALID' | 'EXPIRED' | 'EXHAUSTED';

export const registerStatusLabels: Record<RegisterStatus, string> = {
  ACTIVE: 'Active',
  NOT_YET_VALID: 'Not yet valid',
  EXPIRED: 'Expired',
  EXHAUSTED: 'Fully dispensed',
};

export const registerStatusTones: Record<
  RegisterStatus,
  'success' | 'info' | 'neutral' | 'warning'
> = {
  ACTIVE: 'success',
  NOT_YET_VALID: 'info',
  EXPIRED: 'warning',
  EXHAUSTED: 'neutral',
};

export type RegisterPrescription = {
  id: string;
  validFrom: Date;
  validUntil: Date;
  patient: { displayName: string };
  prescriber: { name: string; registrationNumber?: string | null };
  lines: readonly { remainingAuthorizedUnits: number; medicine: { productName: string } }[];
};

const isoDay = (value: Date) => value.toISOString().slice(0, 10);

/** Status derived from validity dates (compared by calendar day) and remaining units. */
export function registerStatus(rx: RegisterPrescription, todayIso: string): RegisterStatus {
  if (isoDay(rx.validUntil) < todayIso) return 'EXPIRED';
  if (isoDay(rx.validFrom) > todayIso) return 'NOT_YET_VALID';
  if (rx.lines.length > 0 && rx.lines.every((line) => line.remainingAuthorizedUnits <= 0))
    return 'EXHAUSTED';
  return 'ACTIVE';
}

export type RegisterFilter = { query: string; status: RegisterStatus | 'ALL' };

/** Filter the loaded register by patient, prescriber, medicine or reference, plus status. */
export function filterRegister<T extends RegisterPrescription>(
  prescriptions: readonly T[],
  filter: RegisterFilter,
  todayIso: string
): T[] {
  const terms = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return prescriptions.filter((rx) => {
    if (filter.status !== 'ALL' && registerStatus(rx, todayIso) !== filter.status) return false;
    if (terms.length === 0) return true;
    const haystack = [
      rx.id,
      rx.patient.displayName,
      rx.prescriber.name,
      rx.prescriber.registrationNumber ?? '',
      ...rx.lines.map((line) => line.medicine.productName),
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
