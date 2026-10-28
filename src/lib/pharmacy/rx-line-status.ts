/**
 * Current-main #620 references are validated and attached on an open line;
 * quantity/repeats are consumed only during completion, which revalidates them.
 * This display flag never grants dispense permission or consumes a fill.
 */
export function hasAttachedRxReference(line: {
  prescriptionLineId?: string | null;
  prescriptionPatientId?: string | null;
}): boolean {
  return Boolean(line.prescriptionLineId && line.prescriptionPatientId);
}
