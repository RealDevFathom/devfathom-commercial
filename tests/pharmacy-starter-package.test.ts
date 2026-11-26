// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const input = {
  sourceId: 'QA',
  legacyCode: null as string | null,
  name: 'QA medicine',
  packSize: 1,
  class: null as string | null,
  verifiedGeneric: null,
  manufacturerLabel: null,
  active: true,
  controlled: false,
};
const script = resolve('scripts/qa/build-pharmacy-starter.ts');
const run = (cwd: string, ...args: string[]) =>
  execFileSync('bun', [script, ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });

it('refuses an incomplete release without replacing the packaged reference or exposing inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starter-package-'));
  const artifact = join(dir, 'src/lib/pharmacy/migration/starter-products.csv');
  try {
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, 'synthetic existing package');
    writeFileSync(join(dir, 'approved.json'), JSON.stringify([input]));
    writeFileSync(join(dir, 'reviewed.json'), '[]');
    expect(() => run(dir, 'approved.json', 'reviewed.json')).toThrow(
      /Catalogue counts differ from the approved Abuzar inspection/
    );
    expect(() => run(dir, 'approved.json')).toThrow(/two approved catalogue-only JSON projections/);
    writeFileSync(join(dir, 'approved.json'), '{"SYNTHETIC-PRIVATE-MARKER":');
    try {
      run(dir, 'approved.json', 'reviewed.json');
      expect.fail('Malformed projection must fail.');
    } catch (error) {
      const failure = error as { stdout: string; stderr: string; status: number };
      expect(failure.status).toBe(1);
      expect(failure.stdout).toBe('');
      expect(failure.stderr).toBe(
        'Starter catalogue generation failed. Check the approved projections and output location.\n'
      );
    }
    expect(readFileSync(artifact, 'utf8')).toBe('synthetic existing package');
    expect(readdirSync(dirname(artifact))).toEqual(['starter-products.csv']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('publishes synthetic approved totals atomically and preserves the artifact on every release guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starter-package-'));
  const artifact = join(dir, 'src/lib/pharmacy/migration/starter-products.csv');
  const source = Array.from({ length: 26054 }, (_, i) => ({
    ...input,
    sourceId: String(i).padStart(6, '0'),
    legacyCode: i === 1 ? '.' : `00${i}`,
    name: ` Synthetic medicine ${i} `,
    active: i < 18170,
    class: i < 1476 ? 'NARCOTICS' : null,
    controlled: i < 1558,
  }));
  const verified = Array.from({ length: 18068 + 42 + 821 }, (_, i) => ({
    sourceId: String(i < 18110 ? i : i + 26054).padStart(6, '0'),
    name: i < 18068 ? `synthetic medicine ${i}` : 'SYNTHETIC-CONFLICT-DETAIL',
    verifiedGeneric: i < 5496 ? ' Verified generic ' : null,
  }));
  const write = () => {
    writeFileSync(join(dir, 'approved.json'), JSON.stringify(source));
    writeFileSync(join(dir, 'reviewed.json'), JSON.stringify(verified));
  };
  try {
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, 'synthetic previous package');
    const foreign = join(dirname(artifact), 'starter-products.csv.other-invocation.tmp');
    writeFileSync(foreign, 'other invocation');
    write();
    const output = run(dir, 'approved.json', 'reviewed.json');
    expect(JSON.parse(output)).toEqual({
      reconciliation: { matched: 18068, differentName: 42, absentCode: 821 },
      counts: {
        products: 26054,
        active: 18170,
        inactive: 7884,
        narcotics: 1476,
        controlled: 1558,
        generic: 5496,
      },
    });
    const packaged = readFileSync(artifact, 'utf8');
    // Independent inspection: these synthetic fields contain no quotes, commas or newlines.
    const [header, ...lines] = packaged.trimEnd().split('\r\n');
    expect(header).toBe(
      'source_id,legacy_code,name,pack_units,active,class_name,category_name,controlled,generic_name,manufacturer_label,field_source'
    );
    const records = lines.map((line) => line.split(',').map((cell) => JSON.parse(cell) as string));
    expect(records).toHaveLength(26054);
    expect(records.every((row) => row.length === 11)).toBe(true);
    expect(records[0]).toEqual([
      '000000',
      '000',
      ' Synthetic medicine 0 ',
      '1',
      'true',
      'NARCOTICS',
      '',
      'true',
      ' Verified generic ',
      '',
      'Abuzar; V4:generic_name',
    ]);
    expect(records[1]![1]).toBe('');
    expect(records[5496]![10]).toBe('Abuzar');
    expect(records.filter((row) => row[4] === 'true')).toHaveLength(18170);
    expect(records.filter((row) => row[4] === 'false')).toHaveLength(7884);
    expect(records.filter((row) => row[5] === 'NARCOTICS')).toHaveLength(1476);
    expect(records.filter((row) => row[7] === 'true')).toHaveLength(1558);
    expect(records.filter((row) => row[8] !== '')).toHaveLength(5496);
    expect(packaged).not.toContain('SYNTHETIC-CONFLICT-DETAIL');

    for (const [rows, index, patch, message] of [
      [source, 0, { active: false }, /counts differ/],
      [source, 0, { class: null }, /counts differ/],
      [source, 1557, { controlled: false }, /counts differ/],
      [verified, 0, { verifiedGeneric: null }, /counts differ/],
      [verified, 5496, { name: 'SYNTHETIC-CONFLICT-DETAIL' }, /V4 reconciliation differs/],
      [verified, 18068, { sourceId: 'absent' }, /V4 reconciliation differs/],
      // Invalid serialized encoding fails after temp creation, before rename.
      [source, 26053, { name: 'Synthetic\0' }, /Starter catalogue generation failed/],
    ] as const) {
      const row = rows[index]!;
      const original = { ...row };
      Object.assign(row, patch);
      write();
      expect(() => run(dir, 'approved.json', 'reviewed.json')).toThrow(message);
      expect(readFileSync(artifact, 'utf8')).toBe(packaged);
      expect(readdirSync(dirname(artifact)).sort()).toEqual([
        'starter-products.csv',
        'starter-products.csv.other-invocation.tmp',
      ]);
      Object.assign(row, original);
    }
    expect(readFileSync(foreign, 'utf8')).toBe('other invocation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('includes the approved CSV in standalone server traces', async () => {
  const { default: config } = await import('../next.config');
  expect(config.output).toBe('standalone');
  expect(config.outputFileTracingIncludes?.['/*']).toContain(
    'src/lib/pharmacy/migration/starter-products.csv'
  );
});
