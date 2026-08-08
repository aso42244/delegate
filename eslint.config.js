import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.timestamp-*.mjs', '**/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level config files belong to no tsconfig; without this the
          // type-aware rules cannot parse them at all.
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Hard constraint: no dead or commented-out code, no bare TODOs.
      'no-warning-comments': ['error', { terms: ['todo', 'fixme'], location: 'anywhere' }],
      'no-console': 'error',
      // `ignoreRestSiblings` allows the standard way of stripping a secret:
      // `const { passwordHash, ...publicUser } = user`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Money is BigInt; implicit coercion to number would silently lose precision.
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Test files legitimately use non-null assertions on fixtures they just created.
    files: ['**/*.test.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Config files belong to no TypeScript project, so type information for them
    // is unavailable and the type-aware rules can only report false positives.
    files: ['eslint.config.js', 'vitest.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Scripts and CLI entrypoints are the one place stdout is the interface.
    files: ['**/scripts/**/*.ts', '**/cli/**/*.ts', '**/prisma/seed.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
