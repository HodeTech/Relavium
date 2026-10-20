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

const coreProjection = 'packages/core/src/tools/bounding.ts';
const coreProjectionCases = ['packages/core/src/tools/bounding.test.ts'];
const coreProjectionMarker = 'SECRETS_B2_CORE_PROJECTION';
const diagnosticMarker = 'SECRETS_B2_LLM_DIAGNOSTIC';
const splitCoreHeaders = ['\n', '\t'].map(
  (separator) =>
    `masks split schemes, finite header names and URL userinfo (${JSON.stringify(separator)})`,
);
const corePasswords = ['?', '#'].map(
  (separator) => `masks raw ${separator} within password userinfo and preserves contact queries`,
);
const diagnosticPasswords = ['?', '#'].map(
  (separator) => `masks raw ${separator} in userinfo while retaining host contact queries`,
);
const rawPasswordAssignments = ['?', '#'].map(
  (separator) =>
    `preserves public ${separator} tails after userinfo and masks raw password assignments`,
);
// PR95: the extended URL scheme list, the header scheme label and the raw ?/# contact predicate.
const urlSchemes = String.raw`https?|wss?|ftps?|postgres(?:ql)?|mysql|mariadb|rediss?|mongodb(?:\+srv)?|amqps?|ssh|sftp|ldaps?|smtps?`;
const colonlessSchemes = ['http', 'https', 'ws', 'wss', 'ftp', 'ftps'];
const connectionSchemes = [
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'redis',
  'rediss',
  'mongodb',
  'mongodb+srv',
  'amqp',
  'amqps',
  'ssh',
  'sftp',
  'ldap',
  'ldaps',
  'smtp',
  'smtps',
];
const headerSchemeLabelMarker = 'SECRETS_B2_HEADER_SCHEME_LABEL';
const headerSchemeLabelCases = [
  ...['api-key', 'x-api-key', 'x-goog-api-key', 'X-Api-Key'].map(
    (name) => `masks the token after a scheme label in the ${name} header`,
  ),
  'masks every LF/TAB split position inside a scheme label after a header',
  'masks the next token, failing closed, when a scheme label ends the line',
  'masks the token after stacked or quoted scheme labels in a header value',
  'masks the token after more than one whitespace character following a scheme label',
  'masks quoted and escaped tokens beside header scheme labels',
];
const schemeLabel = String.raw`B[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|B[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c`;
const headerName = String.raw`(?:(?:x-)?api-key|x-goog-api-key)\\*["']?\s*:`;
// The header rule, piece by piece, so a control can remove or weaken exactly one guard.
const header = {
  boundary: String.raw`(?<![A-Za-z0-9_-])`,
  separator: String.raw`\\*["']?\s*:\s*["']?`,
  labelRun: String.raw`(?:[^\w\s]*(?:${schemeLabel})(?:[\\"']*(?:${schemeLabel})){0,7}[\\"']*\s+){0,8}`,
  notLabel: String.raw`(?![^\w\s]*(?:(?:${schemeLabel})[\\"']*){1,8}(?:\s|$))`,
  prefix: String.raw`[\\"']*`,
  notNested: String.raw`(?!(?<=[^A-Za-z0-9_-])${headerName})`,
  token: String.raw`(?<token>[^\s"',;}\\][^\s"',;}]*?)`,
  stop: String.raw`(?=(?<=[^A-Za-z0-9_-])${headerName}|\\{0,15}[\s"',;}]|\\{0,15}$)`,
};
const headerLine = (part = {}) => {
  const value = { ...header, ...part };
  return (
    String.raw`      /${value.boundary}(?:(?:x-)?api-key|x-goog-api-key)${value.separator}${value.labelRun}` +
    String.raw`${value.notLabel}${value.prefix}${value.notNested}${value.token}${value.stop}/dgi,`
  );
};
// The one standalone label rule, piece by piece; its first label is either label.
const label = {
  first: String.raw`\b(?:${schemeLabel})`,
  concat: String.raw`(?:[\\"']*(?:${schemeLabel})){0,7}`,
  close: String.raw`[\\"']*\s+`,
  notLabel: String.raw`(?![^\w\s]*(?:(?:${schemeLabel})[\\"']*){1,8}(?:\s|$))`,
  lead: String.raw`[\\"']*`,
  token: String.raw`(?<token>(?=[^\s\\"'])\S*?[^\s\\"',;}])`,
  trail: String.raw`[\\"',;}]*`,
  stop: String.raw`(?=(?<=[^\w])(?:${schemeLabel})(?:[\\"']*(?:${schemeLabel})){0,7}[\\"']*(?:\s|$)|\s|$)`,
};
const labelLine = (part = {}) => {
  const value = { ...label, ...part };
  return (
    String.raw`      /${value.first}${value.concat}${value.close}${value.notLabel}${value.lead}${value.token}` +
    String.raw`${value.trail}${value.stop}/dgi,`
  );
};
const mergedMasking = [
  '  return maskRanges(',
  '    text,',
  '    SECRET_RULES.flatMap((rule) => ruleRanges(text, rule)),',
  '  );',
].join('\n');
const queryRule = (names) => String.raw`/[?&#](?:${names})=(?<token>[^&\s#]+)/dgi`;
const queryNames = String.raw`(?:x[-_])?api[-_]?key|api[-_]?secret|(?:access|secret)[-_]?key|(?:access|refresh|id|auth|session)[-_]?token|client[-_]?secret|key|token|auth|password|secret`;
const overlapMerge = '    if (open !== undefined && range.start < open.end) {';
const mergeExtent = '      open.end = Math.max(open.end, range.end);';
const hostFollowsLine =
  '  return host.length <= HOST_SHAPED_MAX_LENGTH && HOST_SHAPED_AUTHORITY.test(host);';
const llmFixedPoint = '  return toFixedPoint(scrubOnce, text, MASKED);';
const coreFixedPoint = "  return toFixedPoint(redactSecretShapedOnce, text, '[redacted]');";
const coreUserinfoZone =
  '    const ownsUntil = colon >= 0 && (query < 0 || colon < query) ? colon : 0;';
const headerTokenMask = '    mask: tokenGroup,\n    joinedPattern:';
const stackedLabelCase =
  'masks a header token after up to eight stacked labels and fails closed beyond them';
const standaloneStackCase = 'masks the token after any number of stacked standalone labels';
const fixedPointCase = 'keeps already-masked scheme tokens as fixed points';
const hostLengthGuard = '  if (query > HOST_SHAPED_MAX_LENGTH) return false;';
const hostShapedLine = String.raw`  /^(?:[a-z\d-]+(?:\.[a-z\d-]+)+\.?|localhost|\[[\da-f:.]+\])(?::\d{1,5})?$/i;`;
const hostShapedUnanchored = String.raw`  /(?:[a-z\d-]+(?:\.[a-z\d-]+)+\.?|localhost|\[[\da-f:.]+\])(?::\d{1,5})?/i;`;
const hostLookalikeCases = [
  'https://john.doe:s3cret?x=1@h.example/',
  'https://localhostuser:pw?a=b@h.example/',
  'https://user:pw.evil.com?x=1@h.example/',
  'https://h.example:123456?x=1@h.example/',
].map((input) => `masks userinfo whose prefix only resembles a host: ${input}`);
const userinfoContactMarker = 'SECRETS_B2_USERINFO_CONTACT';
const coreUserinfoContactMarker = 'SECRETS_B2_CORE_USERINFO_CONTACT';
const contactAssignmentCases = (secondInput) =>
  ['https://my.user:1234?TOKEN@h.example/', secondInput].map(
    (input) => `masks a host-shaped prefix that no assignment follows: ${input}`,
  );
const contactHostCase =
  'masks userinfo whose raw ?/# follows no host-shaped prefix: https://us?er=1:TOKEN@h.example/';
const contactAssignment = String.raw`  return HOST_SHAPED_AUTHORITY.test(userinfo.slice(0, query)) && userinfo.includes('=', query + 1);`;
const connectionSchemeMarker = 'SECRETS_B2_CONNECTION_SCHEME';
// sftp also matches the original list by its ftp suffix, so the old list still masks it.
const connectionSchemeCases = connectionSchemes
  .filter((scheme) => scheme !== 'sftp')
  .map((scheme) => `masks colon-bearing ${scheme} userinfo and keeps a bare user`);
const urlJoinedMarker = 'SECRETS_B2_URL_JOINED';
const urlJoinedCases = (schemes) => [
  ...schemes.map((scheme) => `masks a split ${scheme} credential around an inner masked span`),
  ...['?', '#'].map(
    (raw) => `masks a split credential holding a raw ${raw} and an inner masked span`,
  ),
];
const urlGluedMarker = 'SECRETS_B2_URL_GLUED_SCHEME';
const urlGluedCases = ['\n', '\t'].map(
  (separator) =>
    `masks a glued scheme whose split credential holds a raw @ (${JSON.stringify(separator)})`,
);
const originalBoundaryMarker = 'SECRETS_B2_ORIGINAL_BOUNDARY';
const originalBoundaryCases = ['sk-proj-', 'AIza'].flatMap((prefix) =>
  ['\n', '\t'].map(
    (separator) =>
      `keeps the original boundary after an embedded greedy prefix ${prefix} (${JSON.stringify(separator)})`,
  ),
);
const headerOriginalBoundaryMarker = 'SECRETS_B2_HEADER_ORIGINAL_BOUNDARY';
const headerOriginalBoundaryCases = ['x-', 'x-goog-'].flatMap((prefix) =>
  ['\n', '\t'].map(
    (separator) =>
      `recovers the original finite header boundary after embedded ${prefix} (${JSON.stringify(separator)})`,
  ),
);
const displayProjectionCases = [
  'apps/cli/src/render/sanitize.test.ts',
  'apps/cli/src/process/render-error.test.ts',
];
const displayOrderMarker = 'SECRETS_B2_DISPLAY_ORDER';
const displayBoundaryMarker = 'SECRETS_B2_DISPLAY_BOUNDARY';
const displayOrderCases = ['\\n', '\\t'].map(
  (separator) =>
    `${displayOrderMarker} protects a complete first fragment in 'inline' with '${separator}'`,
);
const displayBoundaryCases = ['multiline', 'inline'].flatMap((label) =>
  ['\\u0001', '\\u007f', '\\u0085', '\\u202e'].map(
    (separator) =>
      `${displayBoundaryMarker} preserves the original boundary in '${label}' with '${separator}'`,
  ),
);
function displayRendererWitnesses(marker) {
  return ['human', 'human verbose', 'JSON', 'JSON verbose'].map((label) => ({
    target: `${displayOrderMarker} protects original credential evidence in '${label}'`,
    marker,
  }));
}
// Both scanner admission and mapper admission enforce one original-boundary law. Remove both
// exact checks together; removing only the late mapper guard would leave its new prefilter intact.
const coreOriginalBoundary = String.raw`  const candidates = /(^|[^\w])([A-Za-z])/g;
  const separators = /[\n\t]+/g;
  let next = original === joined ? null : separators.exec(original);
  let removed = 0;
  let matchedUntil = 0;
  for (
    let candidate = candidates.exec(original);
    candidate !== null;
    candidate = candidates.exec(original)
  ) {
    const originalStart = candidate.index + candidate[0].length - 1;
    while (next !== null && next.index < originalStart) {
      removed += next[0].length;
      next = separators.exec(original);
    }
    const start = originalStart - removed;
    if (start < matchedUntil) continue;
    JOINED_STANDALONE_CREDENTIAL.lastIndex = 0;
    if (!JOINED_STANDALONE_CREDENTIAL.test(preview(start))) continue;
    JOINED_STANDALONE_CREDENTIAL.lastIndex = start;
    const match = JOINED_STANDALONE_CREDENTIAL.exec(joined);
    if (match === null) continue;
    matchedUntil = JOINED_STANDALONE_CREDENTIAL.lastIndex;
    mask(start, matchedUntil, '[redacted]');
    // A credential glued to the end of this one starts one of its own, as after an applied mask, so a
    // run of fixed-length ids (AKIA…ASIA…) is masked whole in one pass.
    for (let glued = matchedUntil; /[A-Za-z]/.test(joined[glued] ?? ''); glued = matchedUntil) {
      JOINED_STANDALONE_CREDENTIAL.lastIndex = 0;
      if (!JOINED_STANDALONE_CREDENTIAL.test(preview(glued))) break;
      JOINED_STANDALONE_CREDENTIAL.lastIndex = glued;
      if (JOINED_STANDALONE_CREDENTIAL.exec(joined) === null) break;
      matchedUntil = JOINED_STANDALONE_CREDENTIAL.lastIndex;
      mask(glued, matchedUntil, '[redacted]');
    }
  }
}

/**
 * The finite header-label literal is the sole joined-header authority. Check ORIGINAL boundaries
 * before matching, so an embedded x-api-key/x-goog-api-key cannot consume an inner api-key start.
 * Labels are bounded; trailing whitespace cannot contain another label, so failed scans are linear.
 */
function visitJoinedHeaderLabels(original: string, joined: string, mask: SecretSpanVisitor): void {
  if (!joined.includes(':')) return;
  const header = /(?:authorization|(?:x-)?api-key|x-goog-api-key)["']?\s*:/iy;
  const candidates = /(^|[^A-Za-z0-9_-])([A-Za-z])/g;
  const separators = /[\n\t]+/g;
  let next = separators.exec(original);
  let removed = 0;
  let matchedUntil = 0;
  for (
    let candidate = candidates.exec(original);
    candidate !== null;
    candidate = candidates.exec(original)
  ) {
    const originalStart = candidate.index + candidate[0].length - 1;
    while (next !== null && next.index < originalStart) {
      removed += next[0].length;
      next = separators.exec(original);
    }
    const start = originalStart - removed;
    if (start < matchedUntil) continue;
    header.lastIndex = start;
    const match = header.exec(joined);
    if (match === null) continue;
    matchedUntil = header.lastIndex;
    mask(start, matchedUntil, match[0]);
  }
}

/**
 * LF/TAB may split finite credential shapes. Map the spans recognized in the joined view back onto
 * the original text and report the ones a removed separator actually splits; ordinary spaces remain
 * boundaries and public text is never globally normalized for identity. Token-character
 * continuations after LF/TAB are intentionally part of a recognized credential. The two cursors
 * advance monotonically, with no per-character offset array or recursive matcher.
 */
function visitSplitSpans(
  text: string,
  visit: (joined: string, mask: SecretSpanVisitor) => void,
  report: SecretSpanVisitor,
  boundary?: RegExp,
  // URL userinfo owns a separator at either edge: one right after the scheme or before the @ splits it.
  ownsEdges = false,
): void {
  if (!/[\n\t]/.test(text)) return;
  const joined = text.replace(/[\n\t]+/g, '');
  const separators = /[\n\t]+/g;
  let next = separators.exec(text);
  let removed = 0;
  function advance(target: number, includeAtBoundary = false): number {
    while (
      next !== null &&
      (next.index - removed < target || (includeAtBoundary && next.index - removed === target))
    ) {
      removed += next[0].length;
      next = separators.exec(text);
    }
    return target + removed;
  }
  let previousEnd = -1;
  visit(joined, (start, end, replacement, url) => {
    // A separator right before a URL's scheme is outside the URL, so it splits nothing.
    const schemeStart = url === undefined ? undefined : advance(url.schemeStart, true);
    const originalStart = advance(start, !ownsEdges);
    const ownsUntil = url === undefined ? undefined : advance(url.ownsUntil, ownsEdges);
    const originalEnd = advance(end, ownsEdges);
    // A span that starts where the visitor's previous one ended is glued to a credential, which bounds
    // it as an applied mask would.
    const glued = originalStart === previousEnd;
    previousEnd = originalEnd;
    if (!glued && boundary?.test(text[originalStart - 1] ?? '')) return;`;
const withoutCoreOriginalBoundary = coreOriginalBoundary
  .replace(
    String.raw`  const candidates = /(^|[^\w])([A-Za-z])/g;`,
    String.raw`  const candidates = /([A-Za-z])/g;`,
  )
  .replace("    if (!glued && boundary?.test(text[originalStart - 1] ?? '')) return;", '');
/** The complete core projection test file every core projection control runs. */
const CORE_PROJECTION_CASES = 195;
function coreProjectionControl(id, before, after, targets, marker = coreProjectionMarker) {
  return control(
    id,
    coreProjection,
    before,
    after,
    coreProjectionCases,
    CORE_PROJECTION_CASES,
    targets[0],
    marker,
    targets.slice(1).map((target) => ({ target, marker })),
  );
}
/** The complete registry test file the journal-identity control runs. */
const REGISTRY_CASES = 112;
/** The complete scrubber test file every LLM diagnostic control runs. */
const LLM_SCRUB_CASES = 219;
function diagnosticControl(id, before, after, targets, marker = diagnosticMarker) {
  return control(
    id,
    scrubSecretsLeaf,
    before,
    after,
    ['packages/llm/src/scrub-secrets.test.ts'],
    LLM_SCRUB_CASES,
    targets[0],
    marker,
    targets.slice(1).map((target) => ({ target, marker })),
  );
}

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
    queryRule(queryNames),
    queryRule(String.raw`(?:x[-_])?api[-_]?key|key|token|access[-_]?token|auth|password|secret`),
    ['packages/llm/src/llm-error.test.ts'],
    98,
    'SECRETS_CAUSAL_QUERY_NAMES masks each added family without another credential shape',
    'SECRETS_CAUSAL_QUERY_NAMES',
  ),
  control(
    'diagnostic-residual-scrub',
    'apps/cli/src/render/sanitize.ts',
    "  for (const remaining of scrubbed.split('[REDACTED]')) {",
    '  for (const remaining of []) {',
    ['apps/cli/src/render/sanitize.test.ts', 'apps/cli/src/process/render-error.test.ts'],
    180,
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
    "    const residual = remaining.replace(/\\s+/g, '');",
    '    const residual = remaining;',
    [
      'packages/llm/src/llm-error.test.ts',
      'apps/cli/src/render/sanitize.test.ts',
      'apps/cli/src/process/render-error.test.ts',
    ],
    278,
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
    278,
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
    mergedMasking,
    [
      '  const queried = applyRule(text, QUERY_SECRET_RULE);',
      '  return maskRanges(',
      '    queried,',
      '    NON_QUERY_SECRET_RULES.flatMap((rule) => ruleRanges(queried, rule)),',
      '  );',
    ].join('\n'),
    overlapFiles,
    278,
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
    '  const raw = await read();',
    "  const raw = await (deps.readSecretInput?.() ?? Promise.resolve(''));",
    ['apps/cli/src/commands/run.test.ts'],
    84,
    'uses the real native default reader once and suppresses an injected gate selector',
    'SECRETS_CAUSAL_RUN_DEFAULT_READER',
    [
      {
        target:
          'uses the real structural default reader once and suppresses an injected gate selector',
        marker: 'SECRETS_CAUSAL_RUN_DEFAULT_READER',
      },
    ],
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
    73,
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
    18,
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
    133,
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
    133,
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
    11,
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
    84,
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
  // PR #95 B2: independent modern-prefix, joined-view, boundary and malformed-userinfo sites.
  coreProjectionControl(
    'core-modern-key-alphabet',
    String.raw`{ prefix: /sk-/, body: /(?=[\w-]{16})[\w-]+/ }`,
    String.raw`{ prefix: /sk-/, body: /(?=[A-Za-z0-9]{16})[A-Za-z0-9]+/ }`,
    ['sk-proj-', 'sk-svcacct-', 'sk-ant-', 'sk-AAAA'].map(
      (prefix) => `masks the complete modern provider shape ${prefix}`,
    ),
  ),
  coreProjectionControl(
    'core-joined-credential-spans',
    '  visit(joined, (start, end, replacement, url) => {',
    "  visit('', (start, end, replacement, url) => {",
    [
      'masks every LF/TAB split without losing the surrounding public identity',
      ...splitCoreHeaders,
    ],
  ),
  coreProjectionControl(
    'core-joined-original-boundary',
    coreOriginalBoundary,
    withoutCoreOriginalBoundary,
    ['keeps the original left boundary when LF/TAB occurs elsewhere or immediately before a key'],
  ),
  coreProjectionControl(
    'core-split-scheme-label',
    String.raw`/\b(b[\n\t]*e[\n\t]*a[\n\t]*r[\n\t]*e[\n\t]*r|b[\n\t]*a[\n\t]*s[\n\t]*i[\n\t]*c|t[\n\t]*o[\n\t]*k[\n\t]*e[\n\t]*n)\s+(?=[\w.~+/-]{8})[\w.~+/-]+={0,2}/gi`,
    String.raw`/\b(bearer|basic|token)\s+(?=[\w.~+/-]{8})[\w.~+/-]+={0,2}/gi`,
    splitCoreHeaders,
  ),
  coreProjectionControl(
    'core-split-header-label',
    '    mask(start, matchedUntil, match[0]);',
    '    void match;',
    splitCoreHeaders,
  ),
  coreProjectionControl(
    'core-raw-password-userinfo',
    String.raw`const delimiter = /[/\s"',}\]]/g;`,
    String.raw`const delimiter = /[/\s?#"',}\]]/g;`,
    [...corePasswords, ...rawPasswordAssignments],
  ),
  diagnosticControl(
    'diagnostic-joined-before-masking',
    "    if (joined !== undefined && hasSplitCredential(normalized, joined, rule)) return '[REDACTED]';",
    '',
    [
      'masks every LF/TAB split including a complete-looking first key fragment',
      'masks each split position in the finite API header names',
      'treats LF/TAB token-character continuations as credential material even after a complete first fragment',
    ],
  ),
  diagnosticControl(
    'diagnostic-joined-original-boundary',
    "if (letter && !previousWord && !rule.boundary.test(text[originalOffset - 1] ?? '')) {",
    'if (letter) {',
    ['does not invent a key boundary in a public word with a separate newline'],
  ),
  diagnosticControl(
    'diagnostic-split-header-label',
    String.raw`joinedPattern: /(?:(?:x-)?api-key|x-goog-api-key)\\*["']?\s*:/gi,`,
    'joinedPattern: /a^/g,',
    ['masks each split position in the finite API header names'],
  ),
  diagnosticControl(
    'diagnostic-raw-password-userinfo',
    String.raw`  /(?:${urlSchemes}):\/\/[^/\s]*@/gi;`,
    String.raw`  /(?:${urlSchemes}):\/\/[^/\s?#]*@/gi;`,
    [...diagnosticPasswords, ...rawPasswordAssignments],
  ),
  // PR95: a header value's leading Bearer/Basic labels are skipped and its token is masked. Without
  // the label run, the probes see an unmasked label and token and blank the whole diagnostic.
  diagnosticControl(
    'diagnostic-header-scheme-label',
    headerLine(),
    headerLine({ labelRun: '' }),
    headerSchemeLabelCases,
    headerSchemeLabelMarker,
  ),
  control(
    'diagnostic-header-stacked-labels',
    scrubSecretsLeaf,
    headerLine(),
    headerLine({ labelRun: header.labelRun.replace(String.raw`\s+){0,8}`, String.raw`\s+)?`) }),
    ['packages/llm/src/scrub-secrets.test.ts'],
    LLM_SCRUB_CASES,
    'masks the token after stacked or quoted scheme labels in a header value',
    headerSchemeLabelMarker,
    [{ target: stackedLabelCase, marker: 'SECRETS_B2_STACKED_LABEL' }],
  ),
  diagnosticControl(
    'diagnostic-header-label-whitespace',
    headerLine(),
    headerLine({ labelRun: header.labelRun.replace(String.raw`\s+){0,8}`, String.raw`\s){0,8}`) }),
    ['masks the token after more than one whitespace character following a scheme label'],
    headerSchemeLabelMarker,
  ),
  // Every quantified label group is bounded so no admitted-size run can exhaust the RegExp stack.
  diagnosticControl(
    'diagnostic-header-label-bound',
    headerLine(),
    headerLine({ labelRun: header.labelRun.replace(String.raw`\s+){0,8}`, String.raw`\s+)*`) }),
    ['keeps admitted-size label runs linear and fails closed'],
    'SECRETS_B2_HEADER_LABEL_BOUND',
  ),
  diagnosticControl(
    'diagnostic-header-concat-bound',
    headerLine(),
    headerLine({ notLabel: header.notLabel.replace('{1,8}', '+') }),
    ['keeps admitted-size label runs linear and fails closed'],
    'SECRETS_B2_HEADER_LABEL_BOUND',
  ),
  // Round 4: a run of up to eight concatenated labels is one label, in a header value and alone.
  diagnosticControl(
    'diagnostic-header-concat-run',
    headerLine(),
    headerLine({
      labelRun: header.labelRun.replace(String.raw`(?:[\\"']*(?:${schemeLabel})){0,7}`, ''),
    }),
    ['masks the token after a concatenated label run in every context'],
    'SECRETS_B4_CONCAT_LABEL',
  ),
  ...[
    ['diagnostic-label-concat-run', { concat: '' }],
    ['diagnostic-label-concat-stop', { stop: label.stop.replace(label.concat, '') }],
  ].map(([id, part]) =>
    diagnosticControl(
      id,
      labelLine(),
      labelLine(part),
      ['masks the token after a concatenated label run in every context'],
      'SECRETS_B4_CONCAT_LABEL',
    ),
  ),
  // The concatenated run is bounded; the residual of a separate-label run reaches it.
  diagnosticControl(
    'diagnostic-label-start-bound',
    labelLine(),
    labelLine({ concat: label.concat.replace('{0,7}', '*') }),
    ['keeps admitted-size label runs linear and fails closed'],
    'SECRETS_B2_HEADER_LABEL_BOUND',
  ),
  diagnosticControl(
    'diagnostic-label-lead',
    labelLine(),
    labelLine({ lead: '' }),
    ['masks a quoted standalone token after either label'],
    'SECRETS_B4_LABEL_LEAD',
  ),
  // Nine concatenated labels exceed every bounded run, so the diagnostic fails closed, read in the
  // normalized view and in the raw text alike (round 7: each half has its own control).
  ...[
    [
      'diagnostic-label-run-normalized',
      '  if (LABEL_RUN_PAST_BOUND.test(text)) return MASKED;',
      'fails closed on nine labels that only the normalized view joins',
    ],
    [
      'diagnostic-label-run-raw',
      '  if (LABEL_RUN_PAST_BOUND.test(normalized)) return MASKED;',
      'fails closed on nine labels behind a terminal sequence',
    ],
  ].map(([id, after, target]) =>
    diagnosticControl(
      id,
      '  if (LABEL_RUN_PAST_BOUND.test(normalized) || LABEL_RUN_PAST_BOUND.test(text)) return MASKED;',
      after,
      [target],
      'SECRETS_B4_LABEL_RUN_BOUND',
    ),
  ),
  diagnosticControl(
    'diagnostic-label-run-bound',
    '  if (LABEL_RUN_PAST_BOUND.test(normalized) || LABEL_RUN_PAST_BOUND.test(text)) return MASKED;',
    '',
    [
      'fails closed on nine concatenated labels and keeps eight in place',
      'keeps admitted-size label runs total, concatenated or separate',
    ],
    'SECRETS_B4_LABEL_RUN_BOUND',
  ),
  // A header token is never a label, a run of labels or a nested header name.
  diagnosticControl(
    'diagnostic-header-token-not-label',
    headerLine(),
    headerLine({ notLabel: '' }),
    ['treats a whitespace-separated labels-only header value alike in every context'],
    'SECRETS_B3_LABEL_CONTEXT',
  ),
  ...[
    ['diagnostic-header-not-nested', { notNested: '' }],
    [
      'diagnostic-header-nested-stop',
      { stop: header.stop.replace(String.raw`(?<=[^A-Za-z0-9_-])${headerName}|`, '') },
    ],
    ['diagnostic-header-lookbehind', { boundary: '(?:^|[^A-Za-z0-9_-])' }],
  ].map(([id, part]) =>
    diagnosticControl(
      id,
      headerLine(),
      headerLine(part),
      ['keeps every header value and label token apart from a nested header name'],
      'SECRETS_B3_NESTED_HEADER',
    ),
  ),
  // Quotes and escapes around a header token, also in JSON-encoded JSON.
  ...[
    [
      'diagnostic-header-escaped-separator',
      { separator: header.separator.replace(String.raw`\\*["']?\s*:`, String.raw`["']?\s*:`) },
    ],
    ['diagnostic-header-quote-run', { prefix: String.raw`(?:\\*["'])?` }],
  ].map(([id, part]) =>
    diagnosticControl(
      id,
      headerLine(),
      headerLine(part),
      ['masks a header token after any run of quotes or escapes, also in JSON-encoded JSON'],
      'SECRETS_B3_HEADER_ESCAPES',
    ),
  ),
  diagnosticControl(
    'diagnostic-header-escaped-stop',
    headerLine(),
    headerLine({
      stop: header.stop.replace(
        String.raw`|\\{0,15}[\s"',;}]|\\{0,15}$)`,
        String.raw`|[\s"',;}]|$)`,
      ),
    }),
    [fixedPointCase],
    'SECRETS_B2_MASKED_FIXED_POINT',
  ),
  // The standalone label rule: no label as a token, labels closed by a quote, glued labels.
  diagnosticControl(
    'diagnostic-label-token-not-label',
    labelLine(),
    labelLine({ notLabel: '' }),
    [standaloneStackCase],
    'SECRETS_B2_STACKED_LABEL',
  ),
  diagnosticControl(
    'diagnostic-label-quoted-label',
    labelLine(),
    labelLine({ close: String.raw`\s+` }),
    ['masks the token after a label closed by its own quote'],
    'SECRETS_B3_QUOTED_LABEL',
  ),
  ...[
    [
      'diagnostic-label-glued-label',
      { notLabel: label.notLabel.replace(String.raw`[^\w\s]*`, String.raw`[\\"']*`) },
    ],
    [
      'diagnostic-label-embedded-stop',
      {
        stop: label.stop.replace(
          String.raw`(?<=[^\w])(?:${schemeLabel})${label.concat}[\\"']*(?:\s|$)|`,
          '',
        ),
      },
    ],
  ].map(([id, part]) =>
    diagnosticControl(
      id,
      labelLine(),
      labelLine(part),
      ['masks the token after a label glued behind punctuation or inside another token'],
      'SECRETS_B3_GLUED_LABEL',
    ),
  ),
  // Reintroducing round 2's masked-marker guard exposes a tail glued to the marker again.
  diagnosticControl(
    'diagnostic-label-masked-tail',
    labelLine(),
    labelLine({
      lead: String.raw`(?![\\"']*\[REDACTED\](?:[\s"',;}]|$))` + label.lead,
    }),
    ["masks a tail glued to a masked token, including the scrubber's own masks"],
    'SECRETS_B3_MASKED_TAIL',
  ),
  // Masks come from the original text and are merged; each token rule masks only its token.
  diagnosticControl(
    'diagnostic-merged-masking',
    mergedMasking,
    '  return SECRET_RULES.reduce((masked, rule) => applyRule(masked, rule), text);',
    ['masks the token after a label glued behind punctuation or inside another token'],
    'SECRETS_B3_GLUED_LABEL',
  ),
  // Round 4: applying the query names after the merged pass loses a value a header token cut short.
  diagnosticControl(
    'diagnostic-query-merge',
    mergedMasking,
    [
      '  return applyRule(',
      '    maskRanges(',
      '      text,',
      '      NON_QUERY_SECRET_RULES.flatMap((rule) => ruleRanges(text, rule)),',
      '    ),',
      '    QUERY_SECRET_RULE,',
      '  );',
    ].join('\n'),
    ['masks a literal query value in the same pass as every other rule'],
    'SECRETS_B4_QUERY_MERGE',
  ),
  diagnosticControl(
    'diagnostic-mask-merge-extent',
    mergeExtent,
    '      open.end = range.end;',
    ['masks the whole of a range that contains a later one'],
    'SECRETS_B4_MERGE_EXTENT',
  ),
  diagnosticControl(
    'diagnostic-fixed-point',
    llmFixedPoint,
    '  return scrubOnce(text);',
    ['reaches a fixed point'],
    'SECRETS_B4_FIXED_POINT',
  ),
  diagnosticControl(
    'diagnostic-mask-merge',
    overlapMerge,
    '    if (open !== undefined && false) {',
    headerSchemeLabelCases,
    headerSchemeLabelMarker,
  ),
  diagnosticControl(
    'diagnostic-token-only-mask',
    headerTokenMask,
    '    mask: WHOLE_MATCH,\n    joinedPattern:',
    [fixedPointCase],
    'SECRETS_B2_MASKED_FIXED_POINT',
  ),
  // PR95 round 1: the host-shaped prefix is bounded before the RegExp and anchored at both ends.
  diagnosticControl(
    'diagnostic-userinfo-host-length',
    hostLengthGuard,
    '',
    [
      'masks an admitted-size dotted userinfo prefix without exhausting the RegExp stack',
      'bounds the host-shaped prefix at exactly 260 characters, case-insensitively',
    ],
    'SECRETS_B2_USERINFO_HOST_LENGTH',
  ),
  coreProjectionControl(
    'core-userinfo-host-length',
    hostLengthGuard,
    '',
    [
      'masks an admitted-size dotted userinfo prefix without exhausting the RegExp stack',
      'bounds the host-shaped prefix at exactly 260 characters, case-insensitively',
    ],
    'SECRETS_B2_CORE_USERINFO_HOST_LENGTH',
  ),
  diagnosticControl(
    'diagnostic-userinfo-host-anchors',
    hostShapedLine,
    hostShapedUnanchored,
    hostLookalikeCases,
    userinfoContactMarker,
  ),
  coreProjectionControl(
    'core-userinfo-host-anchors',
    hostShapedLine,
    hostShapedUnanchored,
    hostLookalikeCases,
    coreUserinfoContactMarker,
  ),
  // PR95: raw ?/# userinfo is public only after a host-shaped prefix AND an assignment.
  diagnosticControl(
    'diagnostic-userinfo-contact-assignment',
    contactAssignment,
    String.raw`  return HOST_SHAPED_AUTHORITY.test(userinfo.slice(0, query));`,
    contactAssignmentCases('https://host.example#sec@x.example'),
    userinfoContactMarker,
  ),
  control(
    'diagnostic-userinfo-contact-host',
    scrubSecretsLeaf,
    contactAssignment,
    String.raw`  return userinfo.includes('=', query + 1);`,
    ['packages/llm/src/scrub-secrets.test.ts'],
    LLM_SCRUB_CASES,
    contactHostCase,
    userinfoContactMarker,
    rawPasswordAssignments.map((target) => ({ target, marker: diagnosticMarker })),
  ),
  coreProjectionControl(
    'core-userinfo-contact-assignment',
    contactAssignment,
    String.raw`  return HOST_SHAPED_AUTHORITY.test(userinfo.slice(0, query));`,
    contactAssignmentCases('https://provider.example#section@x.example'),
    coreUserinfoContactMarker,
  ),
  control(
    'core-userinfo-contact-host',
    coreProjection,
    contactAssignment,
    String.raw`  return userinfo.includes('=', query + 1);`,
    coreProjectionCases,
    CORE_PROJECTION_CASES,
    contactHostCase,
    coreUserinfoContactMarker,
    rawPasswordAssignments.map((target) => ({ target, marker: coreProjectionMarker })),
  ),
  diagnosticControl(
    'diagnostic-userinfo-authority-rest',
    '  return { start, end: start + at + (hostFollows(tail) ? 0 : 1 + tail.length) };',
    '  return { start, end: start + at };',
    ['masks an ambiguous authority through its end unless a host follows its last @'],
    'SECRETS_B4_AUTHORITY_REST',
  ),
  diagnosticControl(
    'diagnostic-userinfo-rest-length',
    hostFollowsLine,
    '  return HOST_SHAPED_AUTHORITY.test(host);',
    ['bounds the host test after an ambiguous authority at admitted size'],
    'SECRETS_B4_REST_LENGTH',
  ),
  // Round 6: core's rules report ranges on one text and merge them, as the scrubber's do. An
  // ambiguous userinfo's query is read by the later rules, a key or scheme label inside a value
  // starts its own credential, a value runs through earlier masks, and a split header label, a
  // scheme label or a credential may start right after another credential.
  coreProjectionControl(
    'core-merged-ranges',
    '    if (run !== undefined && range.start < run.end) {',
    '    if (run !== undefined && false) {',
    [
      'keeps every credential and its context when core masks overlap',
      ...['\n', '\t', 'word\t', 'DATABASE_URL:\n'].map(
        (prefix) =>
          `masks an ambiguous userinfo with its query values behind ${JSON.stringify(prefix)}`,
      ),
      'masks an ambiguous userinfo whose scheme is split by an LF',
    ],
    'SECRETS_B6_CORE_MERGE',
  ),
  coreProjectionControl(
    'core-userinfo-query-zone',
    coreUserinfoZone,
    '    const ownsUntil = at;',
    [
      'masks an ambiguous userinfo with the query values its later rules would mask whole',
      'masks an admitted-size query value inside an ambiguous userinfo',
    ],
    'SECRETS_B5_CORE_QUERY_EXTENT',
  ),
  coreProjectionControl(
    'core-key-value-nested',
    "    if (delimiterAt - valueStart >= 6) mask(match.index, delimiterAt, '[redacted]');",
    "    if (delimiterAt - valueStart >= 6) {\n      mask(match.index, delimiterAt, '[redacted]');\n      key.lastIndex = delimiterAt;\n    }",
    ["reads a key inside another key's value"],
    'SECRETS_B6_CORE_NESTED_KEY',
  ),
  coreProjectionControl(
    'core-key-value-through-masks',
    '  visitSecretKeyValues(names, fillRanges(text, masked), record);',
    '  visitSecretKeyValues(names, names, record);',
    ['reads a value through the masks before it, line breaks included'],
    'SECRETS_B6_CORE_VALUE_THROUGH_MASK',
  ),
  coreProjectionControl(
    'core-scheme-nested-label',
    '    scheme.lastIndex = labelEnd;',
    '',
    [
      "reads a scheme label inside another label's token",
      'keeps nested values, labels and open PEM blocks linear at admitted size',
    ],
    'SECRETS_B6_CORE_NESTED_LABEL',
  ),
  coreProjectionControl(
    'core-mask-boundaries',
    '  return fillRanges(text, ranges);',
    '  return text;',
    [
      'joins a split header label right after a credential or a PEM block',
      'reads a scheme label or a credential glued to the end of another credential',
    ],
    'SECRETS_B6_CORE_MASK_BOUNDARY',
  ),
  coreProjectionControl(
    'core-userinfo-split-scheme',
    '      schemeStart: match.index,',
    '      schemeStart: start,',
    ['\n', '\t'].map(
      (separator) =>
        `masks URL userinfo whose scheme is split by an LF or TAB (${JSON.stringify(separator)})`,
    ),
    'SECRETS_B5_CORE_SPLIT_SCHEME',
  ),
  coreProjectionControl(
    'core-userinfo-split-edges',
    '  visitSplitSpans(text, visitUrlUserinfo, report, undefined, true);',
    '  visitSplitSpans(text, visitUrlUserinfo, report);',
    ['\n', '\t'].map(
      (separator) =>
        `masks URL userinfo split at either of its edges (${JSON.stringify(separator)})`,
    ),
    'SECRETS_B4_CORE_SPLIT_EDGE',
  ),
  // Round 7: only a username owns its userinfo's text, and none past an LF or TAB; quoted values are
  // scanned without a RegExp repeat; glued credentials chain; the summary uses the projection's fixed
  // point; and an effect whose journal projection never settles is refused before it is prepared.
  coreProjectionControl(
    'core-userinfo-username-zone',
    coreUserinfoZone,
    '    const ownsUntil = query < 0 ? at : colon >= 0 && colon < query ? query : 0;',
    ["reads a key in a userinfo's password or parameter position"],
    'SECRETS_B7_CORE_USERNAME_ZONE',
  ),
  coreProjectionControl(
    'core-split-zone-cap',
    '        : { schemeStart, ownsUntil: split < 0 ? ownsUntil : originalStart + split },',
    '        : { schemeStart, ownsUntil },',
    ["owns no text past a split userinfo's first LF or TAB"],
    'SECRETS_B7_CORE_SPLIT_ZONE',
  ),
  coreProjectionControl(
    'core-quoted-value-scan',
    '      const end = quotedValueEnd(values, valueStart);',
    String.raw`      const quoted = quote === '"' ? /"(?:[^"\\\r\n]|\\[^\r\n])*"/y : /'(?:[^'\\\r\n]|\\[^\r\n])*'/y;
      quoted.lastIndex = valueStart;
      const end = quoted.test(values) ? quoted.lastIndex : -1;`,
    ['projects exactly admitted-size quoted values without exhausting the RegExp stack'],
    'SECRETS_B7_CORE_QUOTED_SCAN',
  ),
  coreProjectionControl(
    'core-standalone-chain',
    "    for (let glued = matchedUntil; /[A-Za-z]/.test(joined[glued] ?? ''); glued = matchedUntil) {",
    '    for (let glued = matchedUntil; false; glued = matchedUntil) {',
    ['masks a run of glued fixed-length ids in one pass, split or not'],
    'SECRETS_B7_CORE_CHAIN',
  ),
  coreProjectionControl(
    'core-glued-span-boundary',
    '    const glued = originalStart === previousEnd;',
    '    const glued = false;',
    ['masks a run of glued fixed-length ids in one pass, split or not'],
    'SECRETS_B7_CORE_CHAIN',
  ),
  coreProjectionControl(
    'core-summary-fixed-point',
    String.raw`  const recognized = /[\n\t]/.test(text) ? redactSecretShapedText(text) : text;`,
    String.raw`  const recognized = /[\n\t]/.test(text) ? redactSecretShapedOnce(text) : text;`,
    ["summarizes with the projection's fixed point before one-line normalization"],
    'SECRETS_B7_CORE_SUMMARY',
  ),
  coreProjectionControl(
    'core-journal-settled',
    '    settled = false;',
    '',
    ['reports whether a journal projection settled'],
    'SECRETS_B7_CORE_JOURNAL_SETTLED',
  ),
  control(
    'core-unsettled-refusal',
    'packages/core/src/tools/registry.ts',
    '  if (journal.unsettled.length > 0) {',
    '  if (false) {',
    ['packages/core/src/tools/registry.test.ts'],
    REGISTRY_CASES,
    'refuses a tiered effect whose journal projection does not settle, before preparing it',
    'SECRETS_B7_CORE_UNSETTLED_REFUSAL',
  ),
  coreProjectionControl(
    'core-fixed-point',
    coreFixedPoint,
    '  return redactSecretShapedOnce(text);',
    ['reaches a fixed point'],
    'SECRETS_B4_CORE_FIXED_POINT',
  ),
  diagnosticControl(
    'diagnostic-url-split-retry',
    "          /[\\n\\t]/.test(text[originalOffset + 1] ?? '') &&",
    '          false &&',
    ['blanks an LF/TAB-split ftp credential after a line that ends in s'],
    'SECRETS_B5_SPLIT_SFTP',
  ),
  // PR95: connection-string schemes join the finite URL list.
  diagnosticControl(
    'diagnostic-connection-scheme-userinfo',
    String.raw`  /(?:${urlSchemes}):\/\/[^/\s]*@/gi;`,
    String.raw`  /(?:https?|wss?|ftps?):\/\/[^/\s]*@/gi;`,
    connectionSchemeCases,
    connectionSchemeMarker,
  ),
  // PR95: only the joined scanner sees a split credential around an inner masked span.
  diagnosticControl(
    'diagnostic-joined-url-userinfo',
    '    joinedPattern: URL_USERINFO_PATTERN,',
    '    joinedPattern: /a^/g,',
    urlJoinedCases([...colonlessSchemes, ...connectionSchemes]),
    urlJoinedMarker,
  ),
  // PR95: the URL rule blocks no start, so a glued scheme is scanned like any other.
  diagnosticControl(
    'diagnostic-url-glued-scheme',
    '    boundary: NO_BOUNDARY,',
    String.raw`    boundary: /\w/,`,
    urlGluedCases,
    urlGluedMarker,
  ),
  // PR95: the `://` prefilter window must cover every listed scheme (`ws` alone fits in two).
  diagnosticControl(
    'diagnostic-url-scheme-window',
    "    anchor: { text: '://', window: URL_SCHEME_WINDOW },",
    "    anchor: { text: '://', window: 2 },",
    urlJoinedCases([...colonlessSchemes, ...connectionSchemes].filter((scheme) => scheme !== 'ws')),
    urlJoinedMarker,
  ),
  // R1-LN-1: recover a valid original start hidden inside a rejected greedy joined candidate.
  coreProjectionControl(
    'core-joined-original-boundary-recovery',
    String.raw`  const candidates = /(^|[^\w])([A-Za-z])/g;`,
    String.raw`  const candidates = /([A-Za-z])/g;`,
    originalBoundaryCases,
    originalBoundaryMarker,
  ),
  diagnosticControl(
    'diagnostic-joined-original-boundary-recovery',
    "!rule.boundary.test(text[originalOffset - 1] ?? '')",
    "!rule.boundary.test((rule.joinedPattern === undefined ? joined[joinedOffset - 1] : text[originalOffset - 1]) ?? '')",
    originalBoundaryCases,
    originalBoundaryMarker,
  ),
  // R2-LN-F1: retain a valid inner header start after a rejected embedded outer label.
  coreProjectionControl(
    'core-header-original-boundary-recovery',
    String.raw`  const candidates = /(^|[^A-Za-z0-9_-])([A-Za-z])/g;`,
    String.raw`  const candidates = /([A-Za-z])/g;`,
    headerOriginalBoundaryCases,
    headerOriginalBoundaryMarker,
  ),
  diagnosticControl(
    'diagnostic-header-original-boundary-recovery',
    "!rule.boundary.test(text[originalOffset - 1] ?? '')",
    "!rule.boundary.test((rule.joinedPattern !== undefined ? joined[joinedOffset - 1] : text[originalOffset - 1]) ?? '')",
    headerOriginalBoundaryCases,
    headerOriginalBoundaryMarker,
  ),
  // R3: retain original credential evidence before independent inline/terminal display transforms.
  control(
    'diagnostic-inline-projection-order',
    'apps/cli/src/render/sanitize.ts',
    '  return sanitizeInline(sanitizeUntrusted(text));',
    '  return sanitizeUntrusted(sanitizeInline(text));',
    displayProjectionCases,
    180,
    displayOrderCases[0],
    displayOrderMarker,
    [
      ...displayOrderCases.slice(1).map((target) => ({ target, marker: displayOrderMarker })),
      ...displayRendererWitnesses(displayOrderMarker),
    ],
  ),
  control(
    'diagnostic-original-control-boundary',
    'apps/cli/src/render/sanitize.ts',
    '  return redactIncludingAcrossSeparators(stripTerminalControls(scrubSecrets(text)));',
    '  return redactIncludingAcrossSeparators(stripTerminalControls(text));',
    displayProjectionCases,
    180,
    displayBoundaryCases[0],
    displayBoundaryMarker,
    [
      ...displayBoundaryCases.slice(1).map((target) => ({ target, marker: displayBoundaryMarker })),
      ...displayRendererWitnesses(displayBoundaryMarker),
    ],
  ),
];
