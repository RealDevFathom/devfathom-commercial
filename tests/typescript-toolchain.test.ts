// @vitest-environment node
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('TypeScript toolchain compatibility', () => {
  it('parses TypeScript with the parser used by eslint-config-next', () => {
    // Resolve from the config so this exercises its installed parser dependency.
    const configRequire = createRequire(require.resolve('eslint-config-next/typescript'));
    const { parser } = configRequire('typescript-eslint');
    const { ast } = parser.parseForESLint('export const value: number = 1;', {
      sourceType: 'module',
    });

    expect(ast.body[0].type).toBe('ExportNamedDeclaration');
    expect(ast.body[0].declaration.declarations[0].id.typeAnnotation.type).toBe(
      'TSTypeAnnotation'
    );
  });
});
