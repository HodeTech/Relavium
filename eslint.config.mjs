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
 * Type-aware rules (`recommendedTypeChecked`) are scoped to the **TS family**
 * (`.ts`/`.tsx`/`.mts`/`.cts`) and wired to `projectService`, so they have a program
 * for every TS variant — including the `.tsx` that arrives with `packages/ui` (0.H).
 * Attaching type-aware rules to a file with no project crashes ESLint, so JS files get
 * `disableTypeChecked`. The no-vendor-type-across-the-`@relavium/llm`-seam import fence
 * (built on the built-in `no-restricted-imports`, per the standard) is wired in 0.F.
 */
export default tseslint.config(
  {
    // Not source: build output, caches, deps, and tooling/config files (at any depth —
    // a bare `*.config.*` would only match the repo root, leaving nested per-package
    // config files to be type-aware-linted with no project, which crashes ESLint).
    ignores: [
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.config.*',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
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
      // CLAUDE.md non-negotiables, pinned as errors across the whole TS family.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Plain JS (and any stray non-ignored JS): never attach type-aware rules — they
    // require a TS program and would otherwise crash ESLint on a file with no project.
    files: ['**/*.{js,jsx,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Prettier compatibility must come last — it turns off all formatting rules.
  prettier,
);
