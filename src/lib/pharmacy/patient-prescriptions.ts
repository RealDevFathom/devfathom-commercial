import { recordAudit } from '@/server/audit';

export type ConsentPurpose = 'DISPENSING' | 'REMINDERS' | 'LOYALTY' | 'MARKETING';
export type DataPurpose = ConsentPurpose | 'CLINICAL_CARE' | 'EXPORT';
export type ClinicalDetailKind = 'PRESCRIPTION' | 'CONDITION' | 'ALLERGY' | 'MEDICINE';

export class NonClinicalDisclosureError extends Error {
  constructor(
    readonly purpose: DataPurpose,
    readonly detail: ClinicalDetailKind
  ) {
    super(`${detail} detail cannot be exposed for ${purpose}`);
    this.name = 'NonClinicalDisclosureError';
  }
}

/** Invariant 21: one mandatory fail-closed boundary for CRM/marketing callers. */
export function assertClinicalDetailPurpose(
  purpose: DataPurpose,
  detail: ClinicalDetailKind
): void {
  if (purpose !== 'DISPENSING' && purpose !== 'CLINICAL_CARE' && purpose !== 'EXPORT') {
    throw new NonClinicalDisclosureError(purpose, detail);
  }
}

export function maskCnic(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length < 4
    ? '*'.repeat(digits.length)
    : `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

export function maskPhone(value: string | null): string | null {
  if (!value) return null;
  const visible = value.slice(-4);
  return `${'*'.repeat(Math.max(0, value.length - 4))}${visible}`;
}

export type ProtectedPatient = {
  id: string;
  displayName: string;
  cnic: string | null;
  phone: string | null;
  dateOfBirth: Date | null;
};

/** Every protected read/export records metadata only; sensitive values never enter the audit row. */
export function auditPatientRead(args: {
  organizationId: string;
  actorId: string;
  patientId: string;
  export?: boolean;
}): void {
  recordAudit({
    organizationId: args.organizationId,
    actorId: args.actorId,
    source: 'TRPC',
    category: 'PHARMACY_PATIENT',
    operation: 'READ',
    action: args.export ? 'pharmacy.patient.export' : 'pharmacy.patient.read',
    targetType: 'PharmacyPatient',
    targetId: args.patientId,
    metadata: { protected: true, purpose: args.export ? 'EXPORT' : 'DISPENSING' },
  });
}

export function maskedPatient(patient: ProtectedPatient): ProtectedPatient {
  return { ...patient, cnic: maskCnic(patient.cnic), phone: maskPhone(patient.phone) };
}

export function hasActiveConsent(
  events: readonly {
    purpose: ConsentPurpose;
    channel: string;
    version: number;
    granted: boolean;
  }[],
  purpose: ConsentPurpose,
  channel: string
): boolean {
  const latest = events
    .filter((event) => event.purpose === purpose && event.channel === channel)
    .sort((a, b) => b.version - a.version)[0];
  return latest?.granted === true;
}
