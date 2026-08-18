/**
 * Assert the repo's LINT FENCES are AIRTIGHT — the seam fence (0.F) and the authored-system-prompt fence
 * (CR-13, ADR-0081 §1).
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
const AUTHORED = 'tools/lint-fixtures/forged-authored-prompt.ts';

const STATIC_RULE = '@typescript-eslint/no-restricted-imports'; // bare, subpath, type-only, 2× re-export
const SYNTAX_RULE = 'no-restricted-syntax'; // dynamic, non-literal dynamic, import-type query, require
const EXPECT_STATIC = 5;
const EXPECT_SYNTAX = 4;

/**
 * The authored-system-prompt fence's exact spec: SEVEN errors on the fixture — five direct assertion
 * forms, the one-hop type alias flagged at its declaration, and a type predicate flagged at its return
 * annotation.
 *
 * A count that DROPS means a forgery syntax stopped being policed. A count that RISES means the fence
 * started catching one of the two forms ADR-0081 §1 names as residual (a generic `as T` helper, an
 * interface field plus an object assertion) — in which case the ADR's honesty about its own bound is now
 * out of date and must be corrected. Either direction is a failure worth stopping CI for.
 */
const EXPECT_AUTHORED = 7;

const eslint = new ESLint();
const results = await eslint.lintFiles([MAIN, CONFIG_NAMED, AUTHORED]);
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

// 3. The authored-system-prompt fence must fire EXACTLY six times — no more, no fewer (see EXPECT_AUTHORED).
const authored = resultFor('forged-authored-prompt.ts');
const authoredHits = (authored?.messages ?? []).filter(
  (m) => m.ruleId === SYNTAX_RULE && m.severity === 2 && m.message.includes('AuthoredSystemPrompt'),
).length;
if (authoredHits !== EXPECT_AUTHORED) {
  fail(
    `AuthoredSystemPrompt fence count drift on ${AUTHORED}: ${authoredHits}/${EXPECT_AUTHORED}. ` +
      'Fewer means a brand-forging syntax stopped being policed (ADR-0081 §1 regression); more means the ' +
      "fence now catches a form the ADR names as residual, so the ADR's stated bound needs updating.",
    authored,
  );
}

console.log(
  `✓ Seam fence airtight: ${STATIC_RULE} ${staticHits}/${EXPECT_STATIC}, ` +
    `${SYNTAX_RULE} ${syntaxHits}/${EXPECT_SYNTAX} on the fixture; ` +
    'config-named source file still fenced.',
);
console.log(
  `✓ AuthoredSystemPrompt fence airtight: ${authoredHits}/${EXPECT_AUTHORED} forging forms policed; ` +
    "the two residual forms ADR-0081 §1 names are still uncaught, and legitimate uses of the type aren't.",
);
