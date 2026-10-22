const ACTION_FAILURE_MESSAGES = {
  inventory: 'The inventory action could not be completed. Review the fields and try again.',
  finance: 'The finance action could not be completed. Review the fields and try again.',
} as const;

/** Return user-safe copy without exposing details from an unexpected server failure. */
export function pharmacyActionErrorMessage(surface: keyof typeof ACTION_FAILURE_MESSAGES): string {
  return ACTION_FAILURE_MESSAGES[surface];
}
