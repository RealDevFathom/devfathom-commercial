import type { Prisma } from '../src/generated/prisma/client';

/** Local setup guidance only: never enumerate hosted tenants in seed output. */
export async function localWorkspaceAddresses(
  tx: Pick<Prisma.TransactionClient, 'organization'>,
  env: Record<string, string | undefined> = process.env
): Promise<string[]> {
  let origin: URL;
  try {
    origin = new URL(env.NEXT_PUBLIC_APP_URL || env.AUTH_URL || 'http://localhost:3000');
  } catch {
    return [];
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    !(
      origin.hostname === 'localhost' ||
      origin.hostname.endsWith('.localhost') ||
      origin.hostname === '127.0.0.1' ||
      origin.hostname === '[::1]'
    )
  )
    return [];

  const port = env.PORT || origin.port;
  const suffix = port ? `:${port}` : '';
  const workspaces = await tx.organization.findMany({
    select: { displayName: true, slug: true },
    orderBy: { slug: 'asc' },
  });
  return [
    '\nLocal workspace sign-in addresses (use the port your dev server runs on):',
    ...workspaces.map(
      ({ displayName, slug }) =>
        `  ${displayName}: ${origin.protocol}//${slug}.localhost${suffix}/login`
    ),
    `  Platform operator: ${origin.protocol}//admin.localhost${suffix}/platform/login`,
    'Plain localhost uses DEFAULT_ORGANIZATION_ID; pharmacy users must use their workspace hostname.',
  ];
}
