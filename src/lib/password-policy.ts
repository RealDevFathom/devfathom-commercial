import { z } from 'zod';

// Shared password rules. Deliberately lenient: at least 8 characters with one
// lowercase letter, one uppercase letter, and one digit. The same `passwordRules`
// list drives the zod schema (server + client) AND the live requirement checklist
// shown while a user types, so the two can never drift apart.

export interface PasswordRule {
  id: string;
  label: string;
  test: (value: string) => boolean;
}

export const passwordRules: PasswordRule[] = [
  { id: 'length', label: 'At least 8 characters', test: (v) => v.length >= 8 },
  { id: 'lower', label: 'One lowercase letter', test: (v) => /[a-z]/.test(v) },
  { id: 'upper', label: 'One uppercase letter', test: (v) => /[A-Z]/.test(v) },
  { id: 'number', label: 'One number', test: (v) => /[0-9]/.test(v) },
];

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters long')
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[0-9]/, 'Password must include a number');

/** True when `value` satisfies every rule in `passwordRules`. */
export function passwordMeetsPolicy(value: string): boolean {
  return passwordRules.every((rule) => rule.test(value));
}
