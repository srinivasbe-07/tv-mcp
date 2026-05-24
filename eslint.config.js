// ESLint v9 flat config for tv-mcp.
// Lints JS and TS sources under src/. Build output and vendored code are ignored.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.log', 'test-results.*'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Tolerate intentionally-unused args prefixed with _.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Server logs to stdout/stderr by design.
      'no-console': 'off',
    },
  },
];
