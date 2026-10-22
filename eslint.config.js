// ESLint for the package: the recommended rules, and type-aware TypeScript rules for src/ and test/.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['node_modules/', 'dist/', 'coverage/', 'examples/*/results/']),
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  // Config files and scripts outside the TypeScript project: no type-aware rules.
  {
    files: ['*.config.{js,ts}', 'eslint.config.js', 'scripts/**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
]);
