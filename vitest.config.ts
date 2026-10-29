import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const databaseSuites = [
  '**/*.db.test.{ts,tsx}',
  '**/*-rls.test.{ts,tsx}',
  'tests/pharmacy-price-intelligence.integration.test.ts',
  'src/lib/platform/audit-secret-redaction.test.ts',
];

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./vitest.server-only.ts', import.meta.url)),
    },
  },
  test: {
    root: projectRoot,
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Migration replay replaces shared functions: DB files must never overlap.
    // Separate projects retain parallel execution for ordinary unit suites.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
          exclude: databaseSuites,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'database',
          include: databaseSuites,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'json-summary', 'html'],
      exclude: [
        'src/generated/**',
        'src/**/*.d.ts',
        'src/**/index.ts',
        'src/app/**/page.tsx',
        'src/app/**/layout.tsx',
      ],
    },
  },
});
