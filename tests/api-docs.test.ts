// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const apiDocs = readFileSync(resolve('docs/admin-platform/api.md'), 'utf8');

function exportedMethods(routePath: string) {
  const route = readFileSync(resolve(routePath), 'utf8');
  return [...route.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\s*=/g)].map(
    ([, method]) => method
  );
}

function documentedMethods(resource: string, path: string) {
  const row = apiDocs.split('\n').find((line) => line.startsWith(`| ${resource} |`));
  expect(row, `Missing REST v1 documentation row for ${resource}`).toBeDefined();

  return [...row!.matchAll(/`(GET|POST|PUT|PATCH|DELETE) ([^`]+)`/g)]
    .filter(([, , documentedPath]) => documentedPath === path)
    .map(([, method]) => method);
}

describe('admin platform REST v1 documentation', () => {
  it.each(['projects', 'clients'])('matches the exported %s route methods', (resource) => {
    const collectionPath = `/api/v1/${resource}`;
    const itemPath = `${collectionPath}/{id}`;

    expect(documentedMethods(resource, collectionPath)).toEqual(
      exportedMethods(`src/app/api/v1/${resource}/route.ts`)
    );
    expect(documentedMethods(resource, itemPath)).toEqual(
      exportedMethods(`src/app/api/v1/${resource}/[id]/route.ts`)
    );
  });
});
