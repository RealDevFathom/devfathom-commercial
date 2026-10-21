import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
export default {
  root,
  resolve: { alias: { '@': root + 'src', 'server-only': root + 'vitest.server-only.ts' } },
  cacheDir: process.env.PAPERCLIP_RUN_SCRATCH_DIR ? process.env.PAPERCLIP_RUN_SCRATCH_DIR + '/vite-catering-money' : root + '.cache/catering-money',
  test: {
    environment: 'node', maxWorkers: 1,
    include: [process.env.CATERING_MONEY_DB_SLOT === 'reserved' ? 'src/lib/restaurant/catering-money.db.test.ts' : 'src/lib/restaurant/catering-money.test.ts'],
  },
};
