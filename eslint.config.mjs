import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // `src/lib/testing` is TEST-ONLY (#39). Nothing keeps a module out of the
  // production bundle except nobody importing it, so that is the thing to
  // enforce: the helper stays unreachable from the app graph exactly as long
  // as only test files reach it.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/lib/testing/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Every specifier that can name the directory, not just the
              // alias: `./testing/*` reaches it from `src/lib`, `../testing/*`
              // from `src/lib/<anything>`, and the bare `@/lib/testing` would
              // resolve the moment an index file appears.
              group: [
                "@/lib/testing",
                "@/lib/testing/*",
                "**/lib/testing/*",
                "./testing/*",
                "../testing/*",
              ],
              message:
                "src/lib/testing is test-only and must never reach the production bundle. Import it from *.test.ts files only.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
