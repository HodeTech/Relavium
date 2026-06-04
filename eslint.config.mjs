// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Single root ESLint flat config shared by every package (no per-package config
 * without a justified override). ESLint owns correctness; Prettier owns formatting
 * (see docs/standards/code-style-typescript.md).
 *
 * The no-vendor-type-across-the-`@relavium/llm`-seam import fence (built on the
 * built-in `no-restricted-imports`, per the standard) is wired in Phase 0 workstream
 * 0.F; this config is the structure it slots into.
 */
export default tseslint.config(
  {
    // Not source: build output, caches, deps, and root tooling/config files.
    ignores: [
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/node_modules/**',
      '*.config.{js,cjs,mjs,ts,mts,cts}',
      'eslint.config.mjs',
      'vitest.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // CLAUDE.md non-negotiables, enforced as errors.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  // Prettier compatibility must come last — it turns off all formatting rules.
  prettier,
);
