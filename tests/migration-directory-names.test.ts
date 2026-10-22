import { readdirSync } from 'node:fs';

describe('Prisma migration directory names', () => {
  it('uses unique, valid timestamps', () => {
    const names = readdirSync('prisma/migrations', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(
      names.every((name) => /^\d{8}([01]\d|2[0-3])[0-5]\d[0-5]\d_/.test(name)),
    ).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});
