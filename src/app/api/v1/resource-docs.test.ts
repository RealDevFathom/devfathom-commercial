import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repositoryFile = (path: string) =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');

describe('REST v1 resource documentation', () => {
  it.each(['projects', 'clients'])(
    'only advertises methods exported by the %s detail route',
    (resource) => {
      const documentation = repositoryFile('docs/admin-platform/api.md');
      const route = repositoryFile(`src/app/api/v1/${resource}/[id]/route.ts`);
      const documentedRow = documentation
        .split('\n')
        .find((line) => line.startsWith(`| ${resource} |`));

      expect(documentedRow).toBeDefined();

      const detailMethods = [
        ...documentedRow!.matchAll(
          new RegExp(`\\b([A-Z]+) /api/v1/${resource}/\\{id\\}(?=\\x60)`, 'g')
        ),
      ].map(([, method]) => method);
      const exportedMethods = [...route.matchAll(/export const ([A-Z]+)\s*=/g)].map(
        ([, method]) => method
      );

      expect(detailMethods).toEqual(exportedMethods);
    }
  );
});
