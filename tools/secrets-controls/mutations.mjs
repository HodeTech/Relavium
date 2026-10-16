/** Steps 3–5 and 7 independent production mechanisms and required named semantic witnesses. */
const reader = 'apps/cli/src/secrets/read-secret.ts';
const readerCases = ['apps/cli/src/secrets/read-secret.test.ts'];
const scrubSecretsLeaf = 'packages/llm/src/scrub-secrets.ts';
const overlapFiles = [
  'packages/llm/src/llm-error.test.ts',
  'apps/cli/src/render/sanitize.test.ts',
  'apps/cli/src/process/render-error.test.ts',
];
const overlapNames = [
  'client_secret',
  'refresh_token',
  'id_token',
  'auth_token',
  'session_token',
  'api_secret',
  'access_key',
  'secret_key',
];
const overlapMarker = 'SECRETS_CAUSAL_OVERLAP_ORDER';
function control(id, path, before, after, files, expectedTests, target, marker, witnesses = []) {
  return { id, path, before, after, files, expectedTests, target, marker, witnesses };
}
function overlapWitnesses(shape) {
  return [
    ...overlapNames.map((name) => ({
      target: `${overlapMarker} protects ${name} ${shape} before query redaction`,
      marker: overlapMarker,
    })),
    ...overlapNames.flatMap((name) =>
      ['multiline', 'inline'].map((label) => ({
        target: `${overlapMarker} protects '${name}' '${shape}' query values: '${label}'`,
        marker: overlapMarker,
      })),
    ),
    ...['human', 'human verbose', 'JSON', 'JSON verbose'].map((label) => ({
      target: `${overlapMarker} protects '${shape}' query values in '${label}' diagnostics`,
      marker: overlapMarker,
    })),
    {
      target: `${overlapMarker} protects a pre-scrubbed ${shape} in a verbose stack`,
      marker: overlapMarker,
    },
  ];
}
const nativeRunCases = ['apps/cli/src/run-secret-inputs.test.ts'];
const nativeModes = ['human', '--verbose', '--json', '--json --verbose'];
const nativeSuccess = (mode) =>
  `delivers one verbatim default-stdin read through real engine start and persists only masks (${mode})`;

export const mutations = [
  control(
    'stdin-cap',
    reader,
    'const MAX_SECRET_BYTES = 65_536;',
    'const MAX_SECRET_BYTES = 131_072;',
    readerCases,
    31,
    'admits exact capacity and refuses aggregate overflow: single Buffer',
    'secrets-stdin-aggregate-cap',
    [
      ...['single string', 'mixed chunks'].map((label) => ({
        target: `admits exact capacity and refuses aggregate overflow: ${label}`,
        marker: 'secrets-stdin-aggregate-cap',
      })),
      ...['single Buffer', 'single string', 'whitespace'].map((label) => ({
        target: `refuses a single oversized chunk before copying or scanning: ${label}`,
        marker: 'secrets-stdin-single-cap',
      })),
    ],
  ),
  control(
    'stdin-ownership',
    reader,
    `owned = Buffer.allocUnsafe(size);
          // Native set reads the Buffer's internal bytes, never its iterator/valueOf/index getters.
          Uint8Array.prototype.set.call(owned, chunk);`,
    'owned = chunk;',
    readerCases,
    31,
    'owns admitted Buffer bytes before advancing a source that reuses them',
    'secrets-stdin-buffer-ownership',
  ),
  control(
    'stdin-zero-retention',
    reader,
    'if (size === 0) continue;',
    'void size;',
    readerCases,
    31,
    'skips zero-byte chunks without retaining or copying them',
    'secrets-stdin-zero-copy',
  ),
  control(
    'stdin-cleanup',
    reader,
    'await iterator.return?.();',
    'void iterator.return?.()?.catch(() => {});',
    readerCases,
    31,
    'awaits early cleanup exactly once with its receiver and does not pull after overflow',
    'secrets-stdin-cleanup-awaited',
  ),
  control(
    'stdin-source-error',
    reader,
    "'could not read secret input from stdin.'",
    'cause instanceof Error ? cause.message : String(cause)',
    readerCases,
    31,
    'normalizes every foreign failure at isTTY to a fresh fixed error',
    'secrets-stdin-source-error',
    [
      'factory-get',
      'factory-call',
      'next-get',
      'next-call',
      'next-reject',
      'done',
      'value',
      'buffer-size',
    ].map((boundary) => ({
      target: `normalizes every foreign failure at ${boundary} to a fresh fixed error`,
      marker: 'secrets-stdin-source-error',
    })),
  ),
  ...[
    ['get', 'OS keychain is unavailable.'],
    ['set', 'could not write to the OS keychain.'],
    ['delete', 'could not access the OS keychain.'],
  ].map(([operation, message]) =>
    control(
      `keychain-${operation}`,
      'apps/cli/src/secrets/os-keychain.ts',
      `'${message}'`,
      'err instanceof Error ? err.message : String(err)',
      ['apps/cli/src/secrets/os-keychain.test.ts'],
      50,
      `SECRETS_CAUSAL_KEYCHAIN_${operation.toUpperCase()} ${operation} wraps constructor Error with opaque content without inspecting it`,
      `SECRETS_CAUSAL_KEYCHAIN_${operation.toUpperCase()}`,
      [
        {
          target: `SECRETS_CAUSAL_KEYCHAIN_${operation.toUpperCase()} ${operation} wraps method Error with opaque content without inspecting it`,
          marker: `SECRETS_CAUSAL_KEYCHAIN_${operation.toUpperCase()}`,
        },
      ],
    ),
  ),
  control(
    'query-names',
    scrubSecretsLeaf,
    String.raw`/([?&](?:(?:x[-_])?api[-_]?key|api[-_]?secret|(?:access|secret)[-_]?key|(?:access|refresh|id|auth|session)[-_]?token|client[-_]?secret|key|token|auth|password|secret)=)[^&\s#]+/gi`,
    String.raw`/([?&](?:(?:x[-_])?api[-_]?key|key|token|access[-_]?token|auth|password|secret)=)[^&\s#]+/gi`,
    ['packages/llm/src/llm-error.test.ts'],
    98,
    'SECRETS_CAUSAL_QUERY_NAMES masks each added family without another credential shape',
    'SECRETS_CAUSAL_QUERY_NAMES',
  ),
  control(
    'diagnostic-residual-scrub',
    'apps/cli/src/render/sanitize.ts',
    '  const scrubbed = scrubSecrets(normalized);',
    `  const scrubbed = scrubSecrets(normalized);
  if (scrubbed !== normalized) return scrubbed;`,
    ['apps/cli/src/render/sanitize.test.ts', 'apps/cli/src/process/render-error.test.ts'],
    161,
    "SECRETS_CAUSAL_RESIDUAL_SCRUB protects 'client_secret' beside a split credential: 'multiline'",
    'SECRETS_CAUSAL_RESIDUAL_SCRUB',
    [
      ...[
        'client_secret',
        'refresh_token',
        'id_token',
        'auth_token',
        'session_token',
        'api_secret',
        'access_key',
        'secret_key',
      ].flatMap((name) =>
        ['multiline', 'inline']
          .filter((label) => name !== 'client_secret' || label !== 'multiline')
          .map((label) => ({
            target: `SECRETS_CAUSAL_RESIDUAL_SCRUB protects '${name}' beside a split credential: '${label}'`,
            marker: 'SECRETS_CAUSAL_RESIDUAL_SCRUB',
          })),
      ),
      ...['human', 'human verbose', 'JSON', 'JSON verbose'].map((label) => ({
        target: `SECRETS_CAUSAL_RESIDUAL_SCRUB protects mixed credentials in '${label}' diagnostics`,
        marker: 'SECRETS_CAUSAL_RESIDUAL_SCRUB',
      })),
      {
        target:
          'SECRETS_CAUSAL_RESIDUAL_SCRUB protects a mixed-credential verbose stack with a benign message',
        marker: 'SECRETS_CAUSAL_RESIDUAL_SCRUB',
      },
    ],
  ),
  control(
    'prefix-before-redaction',
    scrubSecretsLeaf,
    "    const joined = remaining.replace(/\\s+/g, '');",
    '    const joined = remaining;',
    [
      'packages/llm/src/llm-error.test.ts',
      'apps/cli/src/render/sanitize.test.ts',
      'apps/cli/src/process/render-error.test.ts',
    ],
    259,
    'SECRETS_CAUSAL_PREFIX_ORDER protects client_secret before overlapping query redaction',
    'SECRETS_CAUSAL_PREFIX_ORDER',
    [
      ...[
        'refresh_token',
        'id_token',
        'auth_token',
        'session_token',
        'api_secret',
        'access_key',
        'secret_key',
      ].map((name) => ({
        target: `SECRETS_CAUSAL_PREFIX_ORDER protects ${name} before overlapping query redaction`,
        marker: 'SECRETS_CAUSAL_PREFIX_ORDER',
      })),
      ...[
        'client_secret',
        'refresh_token',
        'id_token',
        'auth_token',
        'session_token',
        'api_secret',
        'access_key',
        'secret_key',
      ].flatMap((name) =>
        ['multiline', 'inline'].map((label) => ({
          target: `SECRETS_CAUSAL_PREFIX_ORDER protects '${name}' query values: '${label}'`,
          marker: 'SECRETS_CAUSAL_PREFIX_ORDER',
        })),
      ),
      ...['human', 'human verbose', 'JSON', 'JSON verbose'].map((label) => ({
        target: `SECRETS_CAUSAL_PREFIX_ORDER protects overlapping query values in '${label}' diagnostics`,
        marker: 'SECRETS_CAUSAL_PREFIX_ORDER',
      })),
      {
        target:
          'SECRETS_CAUSAL_PREFIX_ORDER protects a pre-scrubbed overlapping query in a verbose stack',
        marker: 'SECRETS_CAUSAL_PREFIX_ORDER',
      },
      ...overlapWitnesses('URL userinfo'),
    ],
  ),
  control(
    'normalized-secret-probe',
    scrubSecretsLeaf,
    '  return stripTerminalControls(text);',
    '  return text;',
    overlapFiles,
    259,
    `${overlapMarker} protects client_secret normalized key before query redaction`,
    overlapMarker,
    overlapWitnesses('normalized key').filter(
      (witness) =>
        witness.target !==
        `${overlapMarker} protects client_secret normalized key before query redaction`,
    ),
  ),
  control(
    'non-query-before-query',
    scrubSecretsLeaf,
    '  return scrubQuerySecrets(scrubNonQuerySecrets(text));',
    '  return scrubNonQuerySecrets(scrubQuerySecrets(text));',
    overlapFiles,
    259,
    `${overlapMarker} protects client_secret Bearer before query redaction`,
    overlapMarker,
    [
      ...overlapWitnesses('Bearer').filter(
        (witness) =>
          witness.target !==
          `${overlapMarker} protects client_secret Bearer before query redaction`,
      ),
      ...overlapWitnesses('Basic'),
    ],
  ),
  // ADR-0107: independent first-run, default-reader, prompt-authority and native persistence sites.
  control(
    'run-argv-secret-refusal',
    'apps/cli/src/commands/inputs.ts',
    `  for (const decl of declared) {
    if (decl.type === 'secret' && Object.hasOwn(raw, decl.name)) {
      throw new CliError(
        'invalid_invocation',
        'secret inputs cannot be supplied with --input; use --secret-inputs-stdin.',
      );
    }
  }`,
    '',
    ['apps/cli/src/commands/inputs.test.ts'],
    33,
    'refuses every explicitly supplied argv secret before the required loop: ""',
    'SECRETS_CAUSAL_ARGV_SECRET_REFUSAL',
    [
      {
        target:
          'refuses every explicitly supplied argv secret before the required loop: "opaqueArgumentValue"',
        marker: 'SECRETS_CAUSAL_ARGV_SECRET_REFUSAL',
      },
    ],
  ),
  control(
    'run-action-stdin-forwarding',
    'apps/cli/src/commands/specs.ts',
    '      options[option.binding] = readOption(raw, option.binding);',
    "      options[option.binding] = executorId === 'run' && option.binding === 'secretInputsStdin' ? undefined : readOption(raw, option.binding);",
    ['apps/cli/src/commands/specs-forwarding.test.ts'],
    14,
    'SECRETS_CAUSAL_RUN_STDIN_FLAG_FORWARDED: run forwards the boolean through its real action',
    'SECRETS_CAUSAL_RUN_STDIN_FLAG_FORWARDED',
  ),
  control(
    'run-dispatch-stdin-forwarding',
    'apps/cli/src/commands/dispatch.ts',
    "    secretInputsStdin: boolFlag(input.options['secretInputsStdin']),",
    '    secretInputsStdin: false,',
    ['apps/cli/src/commands/dispatch.test.ts'],
    32,
    'run: required workflow + repeatable input (empty list when absent)',
    'SECRETS_CAUSAL_RUN_DISPATCH_FORWARDING',
  ),
  control(
    'run-lazy-native-services',
    'apps/cli/src/commands/dispatch.ts',
    `    // ADR-0107: construct native credential services only after complete input admission.
    resolveKeys: () => keyResolvers(ctx),`,
    '    ...keyResolvers(ctx),',
    nativeRunCases,
    131,
    'refuses malformed ordinary input before native effects (human)',
    'SECRETS_CAUSAL_NATIVE_LAZY_FACTORY',
    nativeModes.slice(1).map((mode) => ({
      target: `refuses malformed ordinary input before native effects (${mode})`,
      marker: 'SECRETS_CAUSAL_NATIVE_LAZY_FACTORY',
    })),
  ),
  control(
    'run-default-secret-reader',
    'apps/cli/src/commands/run.ts',
    '  const raw = await (deps.readSecretInput?.() ?? readSecretFromStdin(RUN_SECRET_STDIN_CONTEXT));',
    "  const raw = await (deps.readSecretInput?.() ?? Promise.resolve(''));",
    ['apps/cli/src/commands/run.test.ts'],
    80,
    'uses the real default reader exactly once and suppresses even an injected gate selector',
    'SECRETS_CAUSAL_RUN_DEFAULT_READER',
  ),
  control(
    'run-consumed-stdin-prompt-authority',
    'apps/cli/src/commands/run.ts',
    '  const mayPrompt = args.secretInputsStdin !== true;',
    '  const mayPrompt = true;',
    ['apps/cli/src/commands/run-secret-consent.test.ts'],
    3,
    'refuses unapproved stdio without prompting or starting a client despite stale TTY metadata',
    'SECRETS_CAUSAL_RUN_CONSUMED_STDIN_CONSENT',
  ),
  control(
    'gate-consumed-stdin-prompt-authority',
    'apps/cli/src/commands/gate.ts',
    '    const mayPrompt = args.secretStdin !== true;',
    '    const mayPrompt = true;',
    ['apps/cli/src/commands/gate.test.ts'],
    68,
    'refuses unapproved stdio after a real read despite stale TTY, without prompting or writing a grant',
    'SECRETS_CAUSAL_RESUME_CONSUMED_STDIN_CONSENT',
  ),
  control(
    'run-native-event-input-mask',
    'packages/core/src/engine/engine.ts',
    `    masked[key] = secretNames.has(key)
      ? ({ secret: true, ref: \`inputs.\${key}\` } satisfies MaskedSecret)
      : value;`,
    '    masked[key] = value;',
    nativeRunCases,
    131,
    nativeSuccess('human'),
    'SECRETS_CAUSAL_NATIVE_EVENT_MASK',
    nativeModes.slice(1).map((mode) => ({
      target: nativeSuccess(mode),
      marker: 'SECRETS_CAUSAL_NATIVE_EVENT_MASK',
    })),
  ),
  control(
    'run-native-input-node-mask',
    'packages/core/src/engine/node-handlers/io.ts',
    "  return { kind: 'completed', output: maskSecretInputs(ctx.inputs, ctx.secretInputNames) };",
    "  return { kind: 'completed', output: ctx.inputs };",
    nativeRunCases,
    131,
    nativeSuccess('human'),
    'SECRETS_CAUSAL_NATIVE_INPUT_NODE_MASK',
    nativeModes.slice(1).map((mode) => ({
      target: nativeSuccess(mode),
      marker: 'SECRETS_CAUSAL_NATIVE_INPUT_NODE_MASK',
    })),
  ),
  control(
    'run-commander-diagnostic-projection',
    'apps/cli/src/commands/specs.ts',
    `      command.configureOutput({
        ...parent.configureOutput(),
        outputError: (_message, write) => write(\`\${hint}\\n\`),
      });
      command.exitOverride((error) => {
        if (error.exitCode === 0) throw error;
        throw new CommanderError(error.exitCode, error.code, hint);
      });`,
    '      command.exitOverride();',
    ['apps/cli/src/run.test.ts'],
    28,
    'SECRETS_CAUSAL_RUN_COMMANDER_OPACITY: human keeps parser values opaque',
    'SECRETS_CAUSAL_RUN_COMMANDER_OPACITY',
    ['human verbose', 'JSON', 'JSON verbose'].map((mode) => ({
      target: `SECRETS_CAUSAL_RUN_COMMANDER_OPACITY: ${mode} keeps parser values opaque`,
      marker: 'SECRETS_CAUSAL_RUN_COMMANDER_OPACITY',
    })),
  ),
  control(
    'run-core-admission-before-services',
    'apps/cli/src/commands/run.ts',
    `  const admitted = resolveAndValidateWorkflowInputs(
    def,
    resolveInputs(def, rawInputs, secretInputs),
  );
  if (!admitted.ok) {
    // Core owns every value contract; raw names were refused above. Never attach caller payload/cause.
    throw new CliError('invalid_invocation', inputAdmissionMessage(admitted.issues));
  }
  const inputs = admitted.inputs;`,
    '  const inputs = resolveInputs(def, rawInputs, secretInputs);',
    nativeRunCases,
    131,
    'refuses secret minimum before native effects (human)',
    'SECRETS_CAUSAL_NATIVE_LAZY_FACTORY',
    [
      'secret minimum',
      'secret maximum',
      'secret pattern',
      'secret format',
      'ordinary minimum',
      'ordinary maximum',
      'ordinary enum',
    ].flatMap((contract) =>
      nativeModes
        .filter((mode) => contract !== 'secret minimum' || mode !== 'human')
        .map((mode) => ({
          target: `refuses ${contract} before native effects (${mode})`,
          marker: 'SECRETS_CAUSAL_NATIVE_LAZY_FACTORY',
        })),
    ),
  ),
  // Wave 2 Step 5: parse-time context, deterministic export IDs and caller-visible review notices.
  control(
    'context-direct-secret-refusal',
    'packages/core/src/interpolation/analyze.ts',
    "    if (site.category === 'input-default') {",
    "    if (site.category === 'context-value' || site.category === 'input-default') {",
    ['packages/core/src/interpolation/analyze.test.ts'],
    22,
    'refuses an unread direct secret-store context reference with value-free parser diagnostics',
    'WAVE2_G22_UNREAD_CONTEXT_REFUSAL',
  ),
  control(
    'export-title-ascii-normalization',
    'packages/core/src/export/serializer.ts',
    "    .normalize('NFKD')\n",
    '',
    ['packages/core/src/export/serializer.test.ts'],
    25,
    'normalizes supported Unicode title forms into deterministic ASCII IDs that round-trip',
    'WAVE2_EXPORT_ASCII_NORMALIZATION',
  ),
  control(
    'export-session-identity-fallback',
    'packages/core/src/export/serializer.ts',
    '  return slug.length > 0 ? slug : fallbackWorkflowId(record.id);',
    "  return slug.length > 0 ? slug : 'exported-session';",
    ['packages/core/src/export/serializer.test.ts'],
    25,
    'uses exact session identity for absent or unusable titles and preserves production UUIDs',
    'WAVE2_EXPORT_IDENTITY_FALLBACK',
  ),
  control(
    'export-odd-session-id-bound',
    'packages/core/src/export/serializer.ts',
    '  return `${SESSION_ID_PREFIX}id-${encoded}`;',
    '  return `${SESSION_ID_PREFIX}${sessionId}`;',
    ['packages/core/src/export/serializer.test.ts'],
    25,
    'bounds odd external session identities with deterministic legal encoding and faithful metadata',
    'WAVE2_EXPORT_EXTERNAL_ID_FALLBACK',
  ),
  control(
    'export-command-review-notice',
    'apps/cli/src/commands/chat-export.ts',
    '    deps.io.writeErr(SESSION_EXPORT_REVIEW_NOTICE);\n',
    '',
    ['apps/cli/src/commands/chat-export.test.ts'],
    15,
    "reports fixed continuity and review notice on stderr after successful 'human' export",
    'W2_EXPORT_COMMAND_NOTICE',
    [
      {
        target:
          "reports fixed continuity and review notice on stderr after successful 'json' export",
        marker: 'W2_EXPORT_COMMAND_NOTICE',
      },
    ],
  ),
  control(
    'export-live-review-notice',
    'apps/cli/src/commands/chat.ts',
    '        emitOutput(SESSION_EXPORT_REVIEW_NOTICE.trimEnd());\n',
    '',
    ['apps/cli/src/commands/chat.test.ts'],
    130,
    "reports fixed continuity and review notice on stderr after live 'human' /export",
    'W2_EXPORT_LIVE_NOTICE',
    [
      {
        target: "reports fixed continuity and review notice on stderr after live 'json' /export",
        marker: 'W2_EXPORT_LIVE_NOTICE',
      },
      {
        target: "renders the live export 'success' through the interactive transcript",
        marker: 'W2_EXPORT_LIVE_RENDERED_NOTICE',
      },
    ],
  ),
  control(
    'export-live-interactive-notice-routing',
    'apps/cli/src/commands/chat.ts',
    '        emitOutput(SESSION_EXPORT_REVIEW_NOTICE.trimEnd());\n',
    '        deps.io.writeErr(SESSION_EXPORT_REVIEW_NOTICE);\n',
    ['apps/cli/src/commands/chat.test.ts'],
    130,
    "renders the live export 'success' through the interactive transcript",
    'W2_EXPORT_LIVE_RENDERED_NOTICE',
  ),
  // Best-effort authored-literal detection and each actual CLI authoring/run caller.
  control(
    'snapshot-literal-detector',
    'apps/cli/src/authoring/snapshot-notice.ts',
    '    if (scrubSecrets(probe) !== probe) matches += 1;',
    '    void probe;',
    ['apps/cli/src/authoring/snapshot-notice.test.ts'],
    10,
    'detects existing credential shapes without values or arbitrary keys in the notice',
    'SNAPSHOT_CAUSAL_DETECTOR',
  ),
  control(
    'snapshot-create-warning',
    'apps/cli/src/commands/create.ts',
    '  warnSnapshotLiterals(parsed.definition, deps.io);\n',
    '',
    ['apps/cli/src/commands/create.test.ts'],
    11,
    'warns value-free on created credential literals and preserves the actual authored file',
    'SNAPSHOT_CAUSAL_CREATE_CALLER',
  ),
  control(
    'snapshot-import-warning',
    'apps/cli/src/commands/import.ts',
    '  warnSnapshotLiterals(parsed.definition, deps.io);\n',
    '',
    ['apps/cli/src/commands/import.test.ts'],
    11,
    'warns value-free on imported metadata and defaults while preserving JSON stdout and the file',
    'SNAPSHOT_CAUSAL_IMPORT_CALLER',
  ),
  control(
    'snapshot-run-warning',
    'apps/cli/src/commands/run.ts',
    '  warnSnapshotLiterals(def, deps.io);\n',
    '',
    ['apps/cli/src/commands/run.test.ts'],
    80,
    'warns after admission before services and preserves the actual augmented frozen workflow',
    'SNAPSHOT_CAUSAL_RUN_CALLER',
  ),
  // ADR-0108: interim admission, exact legacy preservation/clear and dormant/public/error consumers.
  control(
    'provider-header-admission',
    'packages/db/src/provider-store.ts',
    '      const headerWrite = captureHeaderWrite(input);',
    "      const headerWrite = 'preserve';",
    ['packages/db/src/provider-store-headers.test.ts'],
    56,
    'new provider header admission refuses opaque before clock, id or transaction entry',
    'PROVIDER_HEADERS_NO_PLAINTEXT',
    [
      ...['new', 'existing'].flatMap((state) =>
        ['opaque', 'benign']
          .filter((shape) => state !== 'new' || shape !== 'opaque')
          .map((shape) => ({
            target: `${state} provider header admission refuses ${shape} before clock, id or transaction entry`,
            marker: 'PROVIDER_HEADERS_NO_PLAINTEXT',
          })),
      ),
    ],
  ),
  control(
    'provider-header-omission-preservation',
    'packages/db/src/provider-store.ts',
    "headerWrite === 'preserve' ? existing.defaultHeaders : '{}'",
    "'{}'",
    ['packages/db/src/provider-store-headers.test.ts'],
    56,
    'preserves exact legacy JSON for omitted updates',
    'PROVIDER_HEADERS_PRESERVE_LEGACY',
    [
      {
        target: 'preserves exact legacy JSON for undefined updates',
        marker: 'PROVIDER_HEADERS_PRESERVE_LEGACY',
      },
    ],
  ),
  control(
    'provider-header-explicit-clear',
    'packages/db/src/provider-store.ts',
    "headerWrite === 'preserve' ? existing.defaultHeaders : '{}'",
    'existing.defaultHeaders',
    ['packages/db/src/provider-store-headers.test.ts'],
    56,
    'explicit plain empty map clears legacy headers transactionally',
    'PROVIDER_HEADERS_EXPLICIT_CLEAR',
    [
      {
        target: 'explicit null prototype empty map clears legacy headers transactionally',
        marker: 'PROVIDER_HEADERS_EXPLICIT_CLEAR',
      },
    ],
  ),
  control(
    'provider-header-dormant-wire',
    'apps/cli/src/engine/providers.ts',
    '      fetch: getValidatedFetch(),',
    `      fetch: async (input, init, options) => {
        const request = new Request(input, init);
        for (const [name, value] of Object.entries(row.defaultHeaders)) {
          request.headers.set(name, value);
        }
        return getValidatedFetch()(request, undefined, options);
      },`,
    ['apps/cli/src/engine/provider-headers.test.ts'],
    18,
    'custom openai generate: FS_CAUSAL_PROVIDER_HEADER_WIRE keeps legacy maps inert with a positive protocol outcome',
    'FS_CAUSAL_PROVIDER_HEADER_WIRE',
    ['openai', 'deepseek'].flatMap((provider) =>
      ['generate', 'stream', 'listModels']
        .filter((operation) => provider !== 'openai' || operation !== 'generate')
        .map((operation) => ({
          target: `custom ${provider} ${operation}: FS_CAUSAL_PROVIDER_HEADER_WIRE keeps legacy maps inert with a positive protocol outcome`,
          marker: 'FS_CAUSAL_PROVIDER_HEADER_WIRE',
        })),
    ),
  ),
  control(
    'provider-header-public-projection',
    'apps/cli/src/commands/provider.ts',
    `        const outcome = outcomes.get(p.name);
        return {
          name: p.name,`,
    `        const outcome = outcomes.get(p.name);
        return {
          ...p,
          name: p.name,`,
    ['apps/cli/src/commands/provider-headers.test.ts'],
    29,
    'FS_CAUSAL_PROVIDER_HEADER_PUBLIC NDJSON list preserves public fields with offline',
    'FS_CAUSAL_PROVIDER_HEADER_PUBLIC',
    ['success', 'refusal', 'no-key'].map((outcome) => ({
      target: `FS_CAUSAL_PROVIDER_HEADER_PUBLIC NDJSON list preserves public fields with ${outcome}`,
      marker: 'FS_CAUSAL_PROVIDER_HEADER_PUBLIC',
    })),
  ),
  control(
    'provider-header-read-diagnostic',
    'packages/db/src/provider-store.ts',
    `    if (typeof value !== 'string') {
      throw new TypeError(INVALID_STORED_HEADERS);
    }`,
    `    if (typeof value !== 'string') {
      throw new TypeError(\`llm_providers.default_headers['\${key}'] is not a string\`);
    }`,
    ['apps/cli/src/commands/provider-headers.test.ts'],
    29,
    'FS_CAUSAL_PROVIDER_HEADER_DIAGNOSTIC nonstring-command human verbose=true stays loud and content-free',
    'FS_CAUSAL_PROVIDER_HEADER_DIAGNOSTIC',
    [
      {
        target:
          'FS_CAUSAL_PROVIDER_HEADER_DIAGNOSTIC nonstring-factory human verbose=true stays loud and content-free',
        marker: 'FS_CAUSAL_PROVIDER_HEADER_DIAGNOSTIC',
      },
    ],
  ),
];
