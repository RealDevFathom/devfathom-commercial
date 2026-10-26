import mockerPackage from '@vitest/mocker/package.json';
import vitestPackage from 'vitest/package.json';

describe('Vitest mocker security regression', () => {
  it('uses the release that escapes manual mock source and Windows redirect paths', () => {
    // 4.1.12 fixes GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp. Keep this
    // assertion explicit so a lockfile refresh cannot silently restore either flaw.
    expect(mockerPackage.version).toBe('4.1.12');
    expect(vitestPackage.version).toBe('4.1.12');
  });
});
