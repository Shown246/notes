import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', '.cache/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly', fetch: 'readonly', DOMException: 'readonly',
        AbortController: 'readonly', URLSearchParams: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly'
      }
    }
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
);
