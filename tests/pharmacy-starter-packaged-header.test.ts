// @vitest-environment node
// Operator-run acceptance: reads only the packaged CSV header.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('ships exactly the approved eleven columns in order', async () => {
  const stream = createReadStream(resolve('src/lib/pharmacy/migration/starter-products.csv'), {
    encoding: 'utf8',
    highWaterMark: 1,
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    const first = await lines[Symbol.asyncIterator]().next();
    expect(first.value?.replace(/^\uFEFF/, '').split(',')).toEqual([
      'source_id',
      'legacy_code',
      'name',
      'pack_units',
      'active',
      'class_name',
      'category_name',
      'controlled',
      'generic_name',
      'manufacturer_label',
      'field_source',
    ]);
  } finally {
    lines.close();
    stream.destroy();
  }
});
