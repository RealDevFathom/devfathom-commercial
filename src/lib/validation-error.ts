import { ZodError } from 'zod';

export type ValidationErrors = Record<string, string[] | undefined>;

export function formatValidationError(
  error: unknown
): { message: string; fields: ValidationErrors } | null {
  if (!(error instanceof ZodError)) return null;

  const fields = error.flatten().fieldErrors as ValidationErrors;
  const entry = Object.entries(fields).find(([, messages]) => messages?.length);
  const message = entry?.[1]?.[0] ?? error.issues[0]?.message ?? 'Check the highlighted fields.';

  if (!entry) return { message, fields };

  const label = entry[0]
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (character) => character.toUpperCase());

  return { message: `${label}: ${message}`, fields };
}
