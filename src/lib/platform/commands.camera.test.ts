import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = readFileSync('src/lib/platform/commands.ts', 'utf8');
const cameraBlock = source.slice(
  source.indexOf("case 'organization.camera.register'"),
  source.indexOf("case 'catalog.package.upsert'")
);

describe('platform camera command safety', () => {
  test('keeps all routed actions contiguous', () => {
    for (const action of [
      'organization.camera.register',
      'organization.camera.update',
      'organization.camera.remove',
      'catalog.camerapreset',
      'catalog.camerapreset.remove',
    ])
      expect(cameraBlock).toContain(`case '${action}'`);
  });

  test('verifies branch ownership and writes organizationId explicitly', () => {
    expect(cameraBlock).toContain(
      'where: { id: input.branchId, organizationId: input.organizationId }'
    );
    expect(cameraBlock).toContain('organizationId: input.organizationId');
    expect(cameraBlock).not.toContain('restaurantBranch.findUnique');
  });

  test('strict schemas and audit projections reject or omit sensitive input', () => {
    expect(cameraBlock.match(/\.strict\(\)/g)?.length).toBeGreaterThanOrEqual(5);
    expect(
      cameraBlock.match(/omit\(input, 'credentialCiphertext', 'assembledRtspUrl'\)/g)
    ).toHaveLength(2);
  });
});
