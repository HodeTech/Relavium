/**
 * Assert the no-vendor-type-across-the-`@relavium/llm`-seam fence (0.F) is AIRTIGHT.
 *
 * Lints the quarantined fixtures with the repo ESLint config and asserts:
 *  1. `forbidden-vendor-import.ts` fires EXACTLY the expected count per seam rule — the
 *     fixture is the precise spec, so a partial regression (a broken `patterns` group, a
 *     dropped syntax selector) changes a count and fails here rather than passing on the
 *     remaining errors.
 *  2. `forbidden-in-name.config.ts` (a `*.config.ts` SOURCE file) is NOT ignored and still
 *     trips the seam rule — proving the config-file ignore can't be used as an escape hatch.
 *
 * Exits non-zero so CI fails loudly the moment any seam path stops being policed. Run from
 * the repo root:  node tools/lint-fixtures/assert-fence.mjs
 */
import { basename } from 'node:path';

import { ESLint } from 'eslint';

const MAIN = 'tools/lint-fixtures/forbidden-vendor-import.ts';
const CONFIG_NAMED = 'tools/lint-fixtures/forbidden-in-name.config.ts';

const STATIC_RULE = '@typescript-eslint/no-restricted-imports'; // bare, subpath, type-only, 2× re-export
const SYNTAX_RULE = 'no-restricted-syntax'; // dynamic, non-literal dynamic, import-type query, require
const EXPECT_STATIC = 5;
const EXPECT_SYNTAX = 4;

const eslint = new ESLint();
const results = await eslint.lintFiles([MAIN, CONFIG_NAMED]);
// Match by basename (not an `endsWith('/…')` suffix) so it works on Windows, where
// `filePath` uses `\` separators.
const resultFor = (name) => results.find((r) => basename(r.filePath) === name);
const seamErrors = (res, ruleId) =>
  (res?.messages ?? []).filter((m) => m.ruleId === ruleId && m.severity === 2).length;

const fail = (msg, res) => {
  console.error(`✗ ${msg}`);
  for (const m of res?.messages ?? []) {
    console.error(`    L${m.line} [${m.ruleId ?? 'fatal'}] ${m.message}`);
  }
  process.exit(1);
};

// 1. The main fixture must fire EXACTLY the expected counts.
const main = resultFor('forbidden-vendor-import.ts');
const staticHits = seamErrors(main, STATIC_RULE);
const syntaxHits = seamErrors(main, SYNTAX_RULE);
if (staticHits !== EXPECT_STATIC || syntaxHits !== EXPECT_SYNTAX) {
  fail(
    `Seam fence count drift on ${MAIN}: ${STATIC_RULE} ${staticHits}/${EXPECT_STATIC}, ` +
      `${SYNTAX_RULE} ${syntaxHits}/${EXPECT_SYNTAX} — a vendor-import syntax stopped (or ` +
      'started) being policed (ADR-0011 seam regression).',
    main,
  );
}

// 2. The config-named SOURCE file must NOT be ignored — the seam rule must still fire.
const cfg = resultFor('forbidden-in-name.config.ts');
if (!cfg || seamErrors(cfg, STATIC_RULE) < 1) {
  fail(
    `Config-named source file ${CONFIG_NAMED} escaped the seam fence — the config-file ` +
      'ignore was re-broadened and now swallows source files (ADR-0011 seam regression).',
    cfg,
  );
}

console.log(
  `✓ Seam fence airtight: ${STATIC_RULE} ${staticHits}/${EXPECT_STATIC}, ` +
    `${SYNTAX_RULE} ${syntaxHits}/${EXPECT_SYNTAX} on the fixture; ` +
    'config-named source file still fenced.',
);
