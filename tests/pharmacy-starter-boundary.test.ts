// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: read }));

beforeEach(() => {
  vi.resetModules();
  read.mockReset();
});

it('reads only the CSV boundary and refuses missing CSV or an obsolete JSON payload', async () => {
  read.mockImplementation(() => {
    throw new Error('Synthetic missing CSV');
  });
  await expect(import('../src/lib/pharmacy/migration/starter-package')).rejects.toThrow(
    'Synthetic missing CSV'
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]![0]).toMatch(/starter-products\.csv$/);
  vi.resetModules();
  read.mockReturnValue(Buffer.from('null'));
  await expect(import('../src/lib/pharmacy/migration/starter-package')).rejects.toThrow(/headers/);
  expect(read).toHaveBeenCalledTimes(2);
});

it('preserves synthetic metadata without normalization and rejects invalid UTF-8', async () => {
  const header =
    'source_id,legacy_code,name,pack_units,active,class_name,category_name,controlled,generic_name,manufacturer_label,field_source';
  const rows = Array.from({ length: 2 }, (_, i) =>
    [
      String(i).padStart(6, '0'),
      `CUSTOM-${i}`,
      ` Synthetic ${i} `,
      '12',
      String(i === 0),
      i === 0 ? 'NARCOTICS' : '',
      '',
      String(i === 0),
      ' Generic ',
      ' Abuzar ',
      ' Abuzar; V4:generic_name ',
    ].join(',')
  );
  read.mockReturnValue(Buffer.from([header, ...rows].join('\n')));
  const { default: products } = await import('../src/lib/pharmacy/migration/starter-package');
  expect(products).toHaveLength(2);
  expect(products[0]).toMatchObject({
    sourceId: '000000',
    legacyCode: 'CUSTOM-0',
    name: ' Synthetic 0 ',
    packSize: 12,
    manufacturerLabel: ' Abuzar ',
    fieldSource: ' Abuzar; V4:generic_name ',
  });
  expect(read).toHaveBeenCalledTimes(1);
  vi.resetModules();
  read.mockReturnValue(Buffer.from([0xff]));
  await expect(import('../src/lib/pharmacy/migration/starter-package')).rejects.toThrow();
});
