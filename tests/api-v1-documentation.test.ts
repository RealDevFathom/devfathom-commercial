// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readRepositoryFile = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const exportedMethods = (route: string) =>
  [...route.matchAll(/export const (GET|POST|PATCH|PUT|DELETE)\b/g)].map((match) => match[1]);

describe('REST v1 documentation', () => {
  const overview = readRepositoryFile('docs/admin-platform/api.md');

  it.each([
    ['projects', 'src/app/api/v1/projects/[id]/route.ts'],
    ['clients', 'src/app/api/v1/clients/[id]/route.ts'],
  ])('documents the methods exported by the %s detail route', (resource, routePath) => {
    const methods = exportedMethods(readRepositoryFile(routePath));
    const expectedMethods = methods.join(' \\| ');

    expect(methods).toEqual(['GET', 'DELETE']);
    expect(overview).toContain(`\`${expectedMethods} /api/v1/${resource}/{id}\``);
    expect(overview).not.toContain(`PATCH /api/v1/${resource}/{id}`);
  });
});
