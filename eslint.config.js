import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.jarvis/**',
      '**/artifacts/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'apps/web/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // Node + browser globals, declared explicitly instead of pulling in `globals`.
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        EventSource: 'readonly',
        localStorage: 'readonly',
        document: 'readonly',
        window: 'readonly',
        confirm: 'readonly',
        JSX: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Tests and scripts may be looser.
    files: ['**/*.test.ts', 'scripts/**/*.mjs', 'tests/**/*.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
