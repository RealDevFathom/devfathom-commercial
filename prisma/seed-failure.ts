/**
 * DEV-347: turns a seed failure into an actionable message. A unique-constraint
 * violation (Prisma `P2002`) means the database already holds rows the seed
 * tried to create; a raw Prisma stack trace pointing at one `create()` call
 * does not tell the operator what to do about it.
 */
export function describeSeedFailure(error: unknown): string {
  if (isUniqueConstraintViolation(error)) {
    const target = uniqueTarget(error);
    return [
      `❌ Seeding failed: a unique constraint was violated${target ? ` on ${target}` : ''}.`,
      '   This database already contains data the seed tried to create, and the tenant demo data',
      '   was rolled back. The platform operator step, if it printed ✓ above, is committed.',
      '   On a disposable local database, start over with: bun run db:reset && bun run db:seed',
    ].join('\n');
  }
  return `❌ Seeding failed: ${error instanceof Error ? error.message : String(error)}`;
}

type PrismaKnownError = {
  code: string;
  meta?: { modelName?: unknown; target?: unknown };
};

export function isUniqueConstraintViolation(error: unknown): error is PrismaKnownError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function uniqueTarget(error: PrismaKnownError): string | null {
  const model = typeof error.meta?.modelName === 'string' ? error.meta.modelName : null;
  const rawTarget = error.meta?.target;
  const fields = Array.isArray(rawTarget)
    ? rawTarget.join(', ')
    : typeof rawTarget === 'string'
      ? rawTarget
      : null;
  if (model && fields) return `${model} (${fields})`;
  return model ?? fields;
}
