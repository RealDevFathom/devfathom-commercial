const FORBIDDEN_MARKETING_TERMS = [
  'prescription',
  'condition',
  'allerg',
  'medicine',
  'medication',
  'diagnos',
  'patient',
  'drug',
  'mscontin',
] as const;

/** Fail closed for clinical copy even when Unicode or separators disguise a term. */
export function containsClinicalMarketingContent(value: string): boolean {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}|\p{Cf}/gu, '');
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  return (
    FORBIDDEN_MARKETING_TERMS.some((term) => compact.includes(term)) ||
    /(^|[^a-z0-9])r[^a-z0-9]*x([^a-z0-9]|$)/.test(normalized)
  );
}
