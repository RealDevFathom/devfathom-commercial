import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
export default {
  root,
  resolve: { alias: { '@': root + 'src', 'server-only': root + 'vitest.server-only.ts' } },
  test: {
    environment: 'node',
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
    include: [
      'src/lib/restaurant/catering-endpoints.db.test.ts',
      'src/lib/restaurant/catering-money.db.test.ts',
    ],
    testNamePattern: 'catering authenticated endpoints|rejects terminal|refunds revised',
  },
};
