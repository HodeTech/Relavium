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
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import { ESLint } from 'eslint';

const MAIN = 'tools/lint-fixtures/forbidden-vendor-import.ts';
const CONFIG_NAMED = 'tools/lint-fixtures/forbidden-in-name.config.ts';
const AUTHORED = 'tools/lint-fixtures/forged-authored-prompt.ts';
const DATA_MODULE = 'tools/lint-fixtures/forbidden-in-data-module.ts';

const STATIC_RULE = '@typescript-eslint/no-restricted-imports'; // bare, subpath, type-only, 2× re-export
const SYNTAX_RULE = 'no-restricted-syntax'; // dynamic, non-literal dynamic, import-type query, require
const GLOBALS_RULE = 'no-restricted-globals'; // process and Buffer, in the data modules
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

/**
 * The CLI data-module fence's exact spec (ADR-0145 §10), three counts on the one fixture.
 *
 * STATIC: ELEVEN errors from `no-restricted-imports` — `chalk`, `ink` twice (the second under an `eslint-disable` comment that must lift
 * nothing), `ink-spinner`, `react`, `react-dom`, a `node:` module, a bare Node built-in, a `react` subpath, and a vendor SDK of the seam
 * (`openai`) bare and as a subpath (`openai/resources`). A drop means a form a data module must not import stopped being policed (the
 * entry's paths or patterns lost a name, the seam paths fell out of the replaced entry, or an inline comment can lift the fence); a rise means
 * the named list's entry now catches something the fixture did not mean to (read the fixture before changing this number).
 *
 * SYNTAX: NINE errors from `no-restricted-syntax` — six dynamic `import()` forms (`ink`, `react/jsx-runtime`, `chalk`, `ink-spinner`, `node:fs`,
 * and the bare built-in `fs/promises`), the import-type query `import('react').ReactNode`, a `require('node:os')` and a `globalThis.process`. The
 * seam's own syntax rules (a non-literal specifier, a vendor SDK) are carried too and the fixture holds no case of them.
 *
 * GLOBALS: TWO errors from `no-restricted-globals` — a read of `process` and of `Buffer`.
 */
const EXPECT_DATA_MODULE = 11;
const EXPECT_DATA_MODULE_SYNTAX = 9;
const EXPECT_DATA_MODULE_GLOBALS = 2;

/**
 * The modules that must carry the data-module fence, written out HERE and not only read from `eslint.config.mjs`: the list in the config is
 * what is being checked, so a check that read it alone would pass when an entry was dropped. Each must exist (a rename or a deletion fails here,
 * not silently) and each must carry the rule with its full set of names (check 5). The two lists must also be EQUAL (check 6): an entry dropped
 * from this one is not a silent exemption either, and one added to the config without joining this list is not unchecked. A module joins this
 * list in the same commit that joins the config's.
 */
const EXPECTED_DATA_MODULES = [
  'apps/cli/src/commands/repl-commands.ts',
  'apps/cli/src/render/tui/legend.ts',
  'apps/cli/src/render/tui/legend-row.ts',
  'apps/cli/src/render/tui/glyphs.ts',
  'apps/cli/src/render/tui/emphasis.ts',
  'apps/cli/src/render/tui/format.ts',
  'apps/cli/src/render/tui/palette-entries.ts',
  'apps/cli/src/render/tui/chat-keys.ts',
  'apps/cli/src/render/tui/sheet-frame.ts',
  'apps/cli/src/render/tui/tui-constants.ts',
  'apps/cli/src/render/tui/place-label.ts',
  'apps/cli/src/render/notation.ts',
  'apps/cli/src/render/notice-surface.ts',
  'apps/cli/src/render/surface.ts',
  'apps/cli/src/onboarding/setup-notes.ts',
  'apps/cli/src/popups/geometry.ts',
  'apps/cli/src/popups/popup-refusal.ts',
  'apps/cli/src/popups/turn-in-flight.ts',
  'apps/cli/src/popups/chord-refusal.ts',
  'apps/cli/src/popups/custody.ts',
  'apps/cli/src/popups/frame-model.ts',
  'apps/cli/src/popups/opening-guard.ts',
  'apps/cli/src/popups/popup-bind.ts',
  'apps/cli/src/popups/popup-reducer.ts',
  'apps/cli/src/popups/popup-route.ts',
  'apps/cli/src/popups/popup-text.ts',
  'apps/cli/src/popups/popup-copy.ts',
  'apps/cli/src/popups/popup-work.ts',
  'apps/cli/src/popups/doctor-port.ts',
  'apps/cli/src/popups/report-port.ts',
  DATA_MODULE,
];

/** The names the data-module entry must forbid: the renderer and its libraries, and the seam's vendor SDKs (the entry replaces the general one). */
const REQUIRED_PATH_NAMES = [
  'ink',
  'react',
  'react-dom',
  'chalk',
  '@anthropic-ai/sdk',
  'openai',
  '@google/genai',
];
/**
 * The groups the entry must forbid by pattern: `node:` modules, bare Node built-ins (anchored, `/fs`: an unanchored `process` also matches the repo's own
 * `../process/…` directory), subpaths of the renderer libraries and of the vendor SDKs.
 */
const REQUIRED_PATTERN_GROUPS = [
  'node:*',
  '/fs',
  '/path',
  'ink/*',
  'ink-*',
  'react/*',
  'react-dom/*',
  'openai/*',
];
/** The globals the data modules must not read. */
const REQUIRED_GLOBALS = ['process', 'Buffer'];
/** What each data module's `no-restricted-syntax` must still carry (a selector is found by a part of its text), so a dropped selector fails here and not in a review. */
const REQUIRED_SYNTAX_SELECTORS = [
  'ImportExpression[source.value=/^(ink|react|react-dom|chalk)',
  'TSImportType Literal[value=/^(ink|react|react-dom|chalk)',
  "CallExpression[callee.name='require'] > Literal[value=/^(ink|react|react-dom|chalk)",
  '[object.name=/^(globalThis|global)$/][property.name=/^(process|Buffer)$/]',
  "ImportExpression:not([source.type='Literal'])",
];

const eslint = new ESLint();
const results = await eslint.lintFiles([MAIN, CONFIG_NAMED, AUTHORED, DATA_MODULE]);
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

// 4. The CLI data-module fence must fire EXACTLY as often as its fixture says, on each of its three rules (see EXPECT_DATA_MODULE).
const dataModule = resultFor('forbidden-in-data-module.ts');
const dataModuleHits = seamErrors(dataModule, STATIC_RULE);
const dataModuleSyntaxHits = seamErrors(dataModule, SYNTAX_RULE);
const dataModuleGlobalHits = seamErrors(dataModule, GLOBALS_RULE);
if (
  dataModuleHits !== EXPECT_DATA_MODULE ||
  dataModuleSyntaxHits !== EXPECT_DATA_MODULE_SYNTAX ||
  dataModuleGlobalHits !== EXPECT_DATA_MODULE_GLOBALS
) {
  fail(
    `CLI data-module fence count drift on ${DATA_MODULE}: ${STATIC_RULE} ${dataModuleHits}/${EXPECT_DATA_MODULE}, ` +
      `${SYNTAX_RULE} ${dataModuleSyntaxHits}/${EXPECT_DATA_MODULE_SYNTAX}, ${GLOBALS_RULE} ${dataModuleGlobalHits}/${EXPECT_DATA_MODULE_GLOBALS}. ` +
      'Fewer means an ink, react or node: import (static, dynamic, an import-type query or a require), a read of process or Buffer, or an import under an inline ' +
      'eslint-disable stopped being policed in the data modules (ADR-0145 §10 regression).',
    dataModule,
  );
}

// 5. Every module that must be a data module exists and carries the fence with its full names (a dropped, renamed or shadowed entry fails).
for (const file of EXPECTED_DATA_MODULES) {
  if (!existsSync(file)) {
    fail(
      `${file} is on the data-module list but does not exist: a renamed or deleted module must be renamed in eslint.config.mjs and here, not left to pass.`,
    );
  }
  const config = await eslint.calculateConfigForFile(file);
  const entry = config?.rules?.[STATIC_RULE];
  const options = Array.isArray(entry) ? entry[1] : undefined;
  const severity = Array.isArray(entry) ? entry[0] : entry;
  const paths = (options?.paths ?? []).map((path) => (typeof path === 'string' ? path : path.name));
  const groups = (options?.patterns ?? []).flatMap((pattern) =>
    typeof pattern === 'string' ? [pattern] : (pattern.group ?? []),
  );
  const missingPaths = REQUIRED_PATH_NAMES.filter((name) => !paths.includes(name));
  const missingGroups = REQUIRED_PATTERN_GROUPS.filter((group) => !groups.includes(group));
  if (severity !== 2 && severity !== 'error') {
    fail(
      `${file} does not carry ${STATIC_RULE} as an error: it fell off the CLI_DATA_MODULES list in eslint.config.mjs (ADR-0145 §10).`,
    );
  }
  const syntaxEntry = config?.rules?.[SYNTAX_RULE];
  const selectors = (Array.isArray(syntaxEntry) ? syntaxEntry.slice(1) : []).map((option) =>
    typeof option === 'string' ? option : (option?.selector ?? ''),
  );
  const missingSelectors = REQUIRED_SYNTAX_SELECTORS.filter(
    (part) => !selectors.some((selector) => selector.includes(part)),
  );
  const globalsEntry = config?.rules?.[GLOBALS_RULE];
  const restrictedGlobals = (Array.isArray(globalsEntry) ? globalsEntry.slice(1) : []).map(
    (option) => (typeof option === 'string' ? option : (option?.name ?? '')),
  );
  const missingGlobals = REQUIRED_GLOBALS.filter((name) => !restrictedGlobals.includes(name));
  if (config?.linterOptions?.noInlineConfig !== true) {
    fail(
      `${file} honours inline eslint-disable comments: the data-module entry must set linterOptions.noInlineConfig, or a comment lifts the fence from the module it is written in (ADR-0145 §10).`,
    );
  }
  if (missingSelectors.length > 0 || missingGlobals.length > 0) {
    fail(
      `${file} is a data module without its whole syntax and globals fence — missing selectors [${missingSelectors.join(', ')}] and globals [${missingGlobals.join(', ')}]: ` +
        'a dynamic import, an import-type query, a require or a read of process or Buffer is not policed in it (ADR-0145 §10).',
    );
  }
  if (missingPaths.length > 0 || missingGroups.length > 0) {
    fail(
      `${file} carries ${STATIC_RULE} without the data-module names — missing paths [${missingPaths.join(', ')}] and patterns [${missingGroups.join(', ')}]: ` +
        'it is on the general entry, not the data-module one (ADR-0145 §10).',
    );
  }
}

// 6. The two lists are one list. Check 5 holds every module HERE to the fence in the config; this holds every module of the config's list to this one,
// so a name taken off this list (which check 5 would then never look at) or put on the config's alone is a failure, whichever side moved.
const { default: flatConfig } = await import('../../eslint.config.mjs');
const dataEntries = flatConfig.filter(
  (entry) =>
    entry?.linterOptions?.noInlineConfig === true &&
    Array.isArray(entry.files) &&
    entry.files.includes(DATA_MODULE),
);
if (dataEntries.length !== 1) {
  fail(
    `eslint.config.mjs has ${String(dataEntries.length)} data-module entries (a config object with noInlineConfig that lists ${DATA_MODULE}); there must be exactly one (ADR-0145 §10).`,
  );
}
const configured = dataEntries[0].files;
const notChecked = configured.filter((file) => !EXPECTED_DATA_MODULES.includes(file));
const notConfigured = EXPECTED_DATA_MODULES.filter((file) => !configured.includes(file));
if (notChecked.length > 0 || notConfigured.length > 0) {
  fail(
    `The data-module lists differ: on eslint.config.mjs's CLI_DATA_MODULES and not on EXPECTED_DATA_MODULES here [${notChecked.join(', ')}]; ` +
      `on EXPECTED_DATA_MODULES and not on CLI_DATA_MODULES [${notConfigured.join(', ')}]. A module joins both lists in the same commit (ADR-0145 §10).`,
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
console.log(
  `✓ CLI data-module fence airtight: ${dataModuleHits}/${EXPECT_DATA_MODULE} static ink, ink-*, react, react-dom, chalk, node: and vendor-SDK imports, ` +
    `${dataModuleSyntaxHits}/${EXPECT_DATA_MODULE_SYNTAX} dynamic, import-type and require forms, ${dataModuleGlobalHits}/${EXPECT_DATA_MODULE_GLOBALS} process and Buffer reads policed ` +
    `(an eslint-disable comment lifts none); ${EXPECTED_DATA_MODULES.length} named data modules exist and carry it, and they are exactly the config's list.`,
);
