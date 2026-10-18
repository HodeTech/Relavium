import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// CLI depends on these packages: its existing ^build boundary owns their actual compiled exports.
// These controls must not impose a self-dist prerequisite on either package's typecheck.
// Synthetic credentials assembled from fragments, never real provider material.
const key = ['sk-', 'ant-', 'api03-', 'AbCdEf0123456789xyz'].join('');
const googleKey = ['AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'].join('');

const compatibleDiagnostics = [
  { input: `invalid ${key}; retry later`, expected: 'invalid [REDACTED]; retry later' },
  { input: `invalid ${googleKey}; retry later`, expected: 'invalid [REDACTED]; retry later' },
  {
    input: 'https://user:opaque@provider.invalid/x',
    expected: 'https://[REDACTED]@provider.invalid/x',
  },
  { input: 'https://opaque@provider.invalid/x', expected: 'https://[REDACTED]@provider.invalid/x' },
  {
    input: 'Authorization: Bearer opaque-value rejected',
    expected: 'Authorization: Bearer [REDACTED] rejected',
  },
  {
    input: 'Authorization: Basic dXNlcjpwYXNz rejected',
    expected: 'Authorization: Basic [REDACTED] rejected',
  },
  {
    input: '?client_secret=opaque&ordinary=kept#visible',
    expected: '?client_secret=[REDACTED]&ordinary=kept#visible',
  },
  { input: key.slice(0, 12) + '\u0001' + key.slice(12), expected: '[REDACTED]' },
  { input: key.slice(0, 12) + '\n\t' + key.slice(12), expected: '[REDACTED]' },
  { input: `?api_secret=sk-ant-api03-\nAbCdEf0123456789xyz`, expected: '[REDACTED]' },
  { input: `?token=opaque; https://u\nser:opaque@provider.invalid/x`, expected: '[REDACTED]' },
  { input: `?token=opaque; Bear\u202eer opaque-value`, expected: '[REDACTED]' },
  // Literal query names, word boundaries and masked spans retain their finite scope.
  { input: '?api%5fkey=opaque', expected: '?api%5fkey=opaque' },
  { input: '?client_secret_hint=ordinary', expected: '?client_secret_hint=ordinary' },
  { input: '?api_\nkey=opaque', expected: '?api_\nkey=opaque' },
  { input: 'sk-short', expected: 'sk-short' },
  {
    input: 'ordinary prompt prose with an opaque value',
    expected: 'ordinary prompt prose with an opaque value',
  },
  {
    input: '\u001b[31mrate limited\u001b[0m\nretry after 30s',
    expected: '\u001b[31mrate limited\u001b[0m\nretry after 30s',
  },
  { input: '', expected: '' },
];

describe('supported compiled dependency leaves', () => {
  it('retains the shared root and terminal-safe function identity in actual compiled exports', async () => {
    const root = await import('@relavium/shared');
    const leaf = await import('@relavium/shared/terminal-safe');
    expect(typeof leaf.stripTerminalControls).toBe('function');
    expect(root.stripTerminalControls).toBe(leaf.stripTerminalControls);
    expect(leaf.stripTerminalControls('ordinary\u001b[31m text\u001b[0m\u202e')).toBe(
      'ordinary text',
    );
  });

  it('retains one function through the supported compiled root and leaf exports', async () => {
    const root = await import('@relavium/llm');
    const leaf = await import('@relavium/llm/scrub-secrets');
    expect(root.scrubSecrets).toBe(leaf.scrubSecrets);
    for (const { input, expected } of compatibleDiagnostics) {
      expect(leaf.scrubSecrets(input)).toBe(expected);
    }
  });

  it('loads the actual supported compiled leaf with only terminal-safe reachable', () => {
    const require = createRequire(import.meta.url);
    const allowed = [
      pathToFileURL(require.resolve('@relavium/llm/scrub-secrets')).href,
      pathToFileURL(require.resolve('@relavium/shared/terminal-safe')).href,
    ];
    // An isolated ESM loader refuses every other module, including schema/provider barrels.
    // This tests evaluation without relying on bundler tree shaking or warm module caches.
    const loader = `export async function load(url, context, nextLoad) {
      if (!url.startsWith('data:') && !${JSON.stringify(allowed)}.includes(url)) {
        throw new Error('Unexpected sanitizer dependency: ' + url);
      }
      return nextLoad(url, context);
    }`;
    const run = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        `--experimental-loader=data:text/javascript,${encodeURIComponent(loader)}`,
        '--input-type=module',
        '--eval',
        `import { scrubSecrets } from ${JSON.stringify(allowed[0])};
         if (scrubSecrets('?api_key=opaque') !== '?api_key=[REDACTED]') process.exit(1);`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(run.error).toBeUndefined();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});
