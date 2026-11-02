/**
 * Turns the seed failures a developer can act on into one instruction instead
 * of a raw Prisma stack.
 *
 * A unique violation (P2002) is the signature of a database that already holds
 * rows the seed did not expect: the demo data was partly deleted, or another
 * seed wrote the same keys. The seed itself is safe to re-run on a database it
 * populated, so retrying cannot fix this; rebuilding the disposable database can.
 */
type PrismaKnownError = { code: string; meta?: Record<string, unknown> };

function isPrismaKnownError(error: unknown): error is PrismaKnownError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

function asStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

/** `meta.target` from the classic engine; `driverAdapterError` from driver adapters. */
function uniqueTarget(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  const constraint = (
    meta.driverAdapterError as { cause?: { constraint?: Record<string, unknown> } } | undefined
  )?.cause?.constraint;
  const fields = [
    ...asStrings(meta.target),
    ...asStrings(constraint?.fields),
    ...asStrings(constraint?.index),
  ];
  const model = typeof meta.modelName === 'string' ? meta.modelName : undefined;
  if (!fields.length) return model;
  return model ? `${model} (${fields.join(', ')})` : fields.join(', ');
}

export function conflictingSeedDataMessage(error: unknown): string | undefined {
  if (!isPrismaKnownError(error) || error.code !== 'P2002') return undefined;
  const target = uniqueTarget(error.meta);
  return [
    `❌ Seeding failed: this database already contains conflicting seed data${
      target ? ` (unique constraint on ${target})` : ''
    }.`,
    '   Re-running the seed will not fix it. If the database is disposable, run `bun run db:reset`',
    '   (docs/LOCAL_SETUP.md, "Resetting local data"), then seed again.',
  ].join('\n');
}
