import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function read(...parts: string[]) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function filesUnder(...parts: string[]): string[] {
  const directory = join(process.cwd(), ...parts);

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(...parts, entry.name) : [join(directory, entry.name)]
  );
}

function normalized(values: Iterable<string>) {
  return [...new Set([...values].map((value) => value.toLowerCase()))].sort();
}

function createdExtensions(source: string) {
  return [...source.matchAll(/\bCREATE\s+EXTENSION(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([\w$]+)"?/gi)].map(
    ([, name]) => name
  );
}

describe('production deployment contract', () => {
  it('allow-lists every extension created by deployment code', () => {
    const migrationSources = filesUnder('prisma', 'migrations').filter((path) =>
      path.endsWith('.sql')
    );
    const prismaSources = readdirSync(join(process.cwd(), 'prisma'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(process.cwd(), 'prisma', entry.name));
    const requiredExtensions = normalized(
      [...migrationSources, ...prismaSources, ...filesUnder('scripts')].flatMap((path) =>
        createdExtensions(readFileSync(path, 'utf8'))
      )
    );

    const extensionPreparation = read('prisma', 'prepare-extensions.sql');
    const preparationList = extensionPreparation.match(
      /FOREACH\s+target_extension\s+IN\s+ARRAY\s+ARRAY\[([^\]]+)]::name\[\]/i
    );
    expect(preparationList).not.toBeNull();
    expect(
      normalized([...preparationList![1].matchAll(/'([^']+)'/g)].map(([, name]) => name))
    ).toEqual(requiredExtensions);
  });
});
