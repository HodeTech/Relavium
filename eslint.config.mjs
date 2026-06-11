// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * The no-vendor-type-across-the-`@relavium/llm`-seam fence (0.F). Provider SDKs may be
 * imported ONLY inside `packages/llm/src/adapters/*`; everywhere else — the engine
 * (`@relavium/core`) and every surface — depends on Relavium/Zod seam types only
 * (ADR-0011, code-style-typescript.md §module-boundaries).
 *
 * The fence is TWO complementary rules applied to BOTH TS and JS source (TypeScript-first,
 * but a stray `.js`/`.mjs` must not be an escape hatch), because a vendor SDK — or a
 * vendor *type*, the core failure mode — can cross the seam through several syntaxes:
 * - `no-restricted-imports` covers the STATIC forms: `import …`, `export … from …`,
 *   `export * from …`, the subpath `openai/resources` (via `patterns`), and
 *   `import type { … } from …` (the @typescript-eslint variant, used for TS, polices
 *   type-only imports too).
 * - `no-restricted-syntax` covers the forms `no-restricted-imports` cannot see: dynamic
 *   `import('openai')`, ANY non-literal dynamic `import(expr)` (a static check cannot see
 *   through a computed specifier, so it is banned outright outside adapters), the
 *   import-type query `import('openai').X` (a pure type leak), and `require('openai')`.
 * All are lifted together only inside the adapter zone, and every form is exercised by the
 * fixture under `tools/lint-fixtures/` (asserted live by `assert-fence.mjs`).
 */
const SEAM_VENDOR_SDKS = ['@anthropic-ai/sdk', 'openai', '@google/genai'];
const SEAM_MESSAGE =
  'Provider SDKs must not cross the @relavium/llm seam — import them only inside ' +
  'packages/llm/src/adapters/* (ADR-0011). The engine and surfaces use Relavium/Zod ' +
  'seam types only, never a vendor SDK type.';
const SEAM_DYNAMIC_MESSAGE =
  'Dynamic import() with a non-literal specifier is not allowed outside ' +
  'packages/llm/src/adapters/* — a computed specifier can smuggle a provider SDK past the ' +
  '@relavium/llm seam (ADR-0011). Use a static import of a Relavium/seam module; if a ' +
  'computed import is genuinely needed, justify it with an explicit eslint-disable.';

// Shared options for both the @typescript-eslint (TS) and core (JS) no-restricted-imports.
const seamImportOptions = {
  paths: SEAM_VENDOR_SDKS.map((name) => ({ name, message: SEAM_MESSAGE })),
  patterns: [{ group: SEAM_VENDOR_SDKS.map((name) => `${name}/*`), message: SEAM_MESSAGE }],
};
const seamImportEntry = /** @type {const} */ (['error', seamImportOptions]);

// A regex matching each vendor specifier and any subpath (slashes escaped for the esquery
// attribute literal). `String.raw` keeps the backslashes literal so it reads like the
// regex it is. Drives the AST selectors that catch the non-static import forms.
const SEAM_SPECIFIER_RE = String.raw`^(@anthropic-ai\/sdk|openai|@google\/genai)(\/.*)?$`;
const seamSyntaxRules = /** @type {const} */ ([
  'error',
  // dynamic import of a vendor specifier: `import('openai')`
  { selector: `ImportExpression[source.value=/${SEAM_SPECIFIER_RE}/]`, message: SEAM_MESSAGE },
  // ANY non-literal dynamic import — a computed specifier evades the static check above.
  { selector: "ImportExpression:not([source.type='Literal'])", message: SEAM_DYNAMIC_MESSAGE },
  // import-type query (a pure type leak): `import('openai').OpenAI`
  { selector: `TSImportType Literal[value=/${SEAM_SPECIFIER_RE}/]`, message: SEAM_MESSAGE },
  // CommonJS interop: `require('openai')`
  {
    selector: `CallExpression[callee.name='require'] > Literal[value=/${SEAM_SPECIFIER_RE}/]`,
    message: SEAM_MESSAGE,
  },
]);

/**
 * Single root ESLint flat config shared by every package (no per-package config
 * without a justified override). ESLint owns correctness; Prettier owns formatting
 * (see docs/standards/code-style-typescript.md).
 *
 * Type-aware rules (`recommendedTypeChecked`) are scoped to the **TS family**
 * (`.ts`/`.tsx`/`.mts`/`.cts`) and wired to `projectService`, so they have a program
 * for every TS variant — including the `.tsx` that arrives with `packages/ui`. Attaching
 * type-aware rules to a file with no project crashes ESLint, so JS files get
 * `disableTypeChecked`. The seam fence above is applied to both families.
 */
export default tseslint.config(
  {
    // Not source: build output, caches, and deps.
    ignores: [
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/node_modules/**',
      // Tooling/config files live at the repo, package, or app ROOT (never under a package
      // `src/`) and are not in any tsconfig, so type-aware linting would crash on them.
      // Ignore them by their ROOT locations only — a broad `**/*.config.*` would also
      // swallow a source file named `*.config.ts` and silently exempt it from the seam
      // fence. New nested config locations are added here explicitly, by design.
      '*.config.*',
      'packages/*/*.config.*',
      'apps/*/*.config.*',
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
      // No ambient platform globals here on purpose. Type-aware linting disables
      // `no-undef` for TS, so globals don't gate undefined names — each package's
      // tsconfig `types`/`lib` is the real platform boundary (e.g. `@relavium/shared`
      // sets `types: []`, so `process` is a TS error). Platform globals are added per
      // surface at its phase: `globals.node` for apps/cli + apps/api + Node tooling;
      // `globals.browser` for packages/ui + apps/desktop frontend + apps/portal; the
      // pure engine (`@relavium/core`) and libraries use neither.
    },
    rules: {
      // CLAUDE.md non-negotiables, pinned as errors across the whole TS family.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      // The seam fence (0.F): static specifiers (incl. `import type`) + the
      // dynamic/import-type/require forms that evade the first.
      '@typescript-eslint/no-restricted-imports': seamImportEntry,
      'no-restricted-syntax': seamSyntaxRules,
    },
  },
  {
    // Plain JS (and any stray non-ignored JS): never attach type-aware rules — they
    // require a TS program and would otherwise crash ESLint on a file with no project.
    files: ['**/*.{js,jsx,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      // The seam fence on JS source too. JS has no `import type`, so the core
      // `no-restricted-imports` is the right variant here.
      'no-restricted-imports': seamImportEntry,
      'no-restricted-syntax': seamSyntaxRules,
    },
  },
  {
    // The repo's Node tooling scripts (the seam-fence assert + the engine-deps guard).
    // This is the "globals.node for Node tooling" slot promised above, granted narrowly
    // and inline (no `globals` package) — only what the scripts actually touch. ESLint 9
    // flat config ignores `/* eslint-env */` comments, so the grant must live here.
    files: ['tools/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    // The seam's ONE legal zone: provider SDKs are imported only inside the adapters,
    // which translate vendor shapes to Relavium/Zod seam types (ADR-0011). Every seam
    // rule (both variants + the syntax rule) is lifted here and nowhere else.
    files: ['packages/llm/src/adapters/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    // Quarantined lint fixtures (0.F): files that pull a forbidden vendor SDK across the
    // seam through every syntax on purpose, so `tools/lint-fixtures/assert-fence.mjs` can
    // prove the fence is airtight. They belong to no tsconfig, so type-aware linting and
    // the project service are off here — the seam rules (not type-aware) still fire.
    files: ['tools/lint-fixtures/**/*.{ts,mts,cts}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false } },
  },
  // Prettier compatibility must come last — it turns off all formatting rules.
  prettier,
);
