import { describe, expect, it } from 'vitest';

import { CLI_VERSION } from './program.js';
import { run } from './run.js';
import { captureIo } from './test-support.js';

const argv = (...tokens: string[]): string[] => ['node', 'relavium', ...tokens];

/** Runtime-validate the parsed `--json` error envelope rather than asserting its type. */
function isErrorEnvelope(value: unknown): value is { type: string; code: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'code' in value &&
    typeof value.code === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  );
}

describe('run', () => {
  it('prints help and exits 0 for --help', async () => {
    const { io, out } = captureIo();
    expect(await run(argv('--help'), io)).toBe(0);
    expect(out()).toContain('Usage: relavium');
    expect(out()).toContain('run');
    expect(out()).toContain('Global options');
  });

  it('prints help and exits 0 for a bare invocation', async () => {
    const { io, out } = captureIo();
    expect(await run(argv(), io)).toBe(0);
    expect(out()).toContain('Usage: relavium');
  });

  it('prints the version and exits 0 for --version', async () => {
    const { io, out } = captureIo();
    expect(await run(argv('--version'), io)).toBe(0);
    expect(out()).toContain(CLI_VERSION);
  });

  // The `--json` machine-output contract (ADR-0049) is scoped to a workflow RUN. --help / --version /
  // a bare invocation are exit-0 meta-operations that still print human text to stdout under --json —
  // and nothing to stderr.
  it('keeps --help / --version / bare as human-on-stdout exit-0 meta-ops even under --json', async () => {
    const help = captureIo();
    expect(await run(argv('--json', '--help'), help.io)).toBe(0);
    expect(help.out()).toContain('Usage: relavium');
    expect(help.err()).toBe('');

    const version = captureIo();
    expect(await run(argv('--json', '--version'), version.io)).toBe(0);
    expect(version.out()).toContain(CLI_VERSION);
    expect(version.err()).toBe('');

    const bare = captureIo();
    expect(await run(argv('--json'), bare.io)).toBe(0);
    expect(bare.out()).toContain('Usage: relavium');
    expect(bare.err()).toBe('');
  });

  it('keeps stderr a single JSON envelope under --json even with --verbose (no raw stack)', async () => {
    const { io, out, err } = captureIo();
    expect(await run(argv('init', '--json', '--verbose'), io)).toBe(2); // `init` is a stub (2.J landed `create`)
    expect(out()).toBe('');
    // stderr is exactly one parseable JSON line — --verbose adds no raw stack text under --json.
    const lines = err().trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(isErrorEnvelope(JSON.parse(lines[0] ?? ''))).toBe(true);
  });

  it('exits 2 for an unknown command', async () => {
    const { io, err } = captureIo();
    expect(await run(argv('bogus'), io)).toBe(2);
    expect(err().toLowerCase()).toContain('unknown command');
  });

  it('exits 2 when a required argument is missing', async () => {
    const { io } = captureIo();
    expect(await run(argv('run'), io)).toBe(2);
  });

  it('exits 2 for a bare `gate` (no runId, no subcommand) — the guard, not a stack', async () => {
    // 2.G regression guard: restructuring `gate <runId>` → `gate [runId]` (so `gate list` can be a
    // subcommand) must keep a bare `gate` an exit-2 invocation fault. The runId guard throws before any
    // db/keychain access, so this exercises only the routing + guard.
    const { io, err } = captureIo();
    expect(await run(argv('gate'), io)).toBe(2);
    expect(err()).toContain('requires a <runId>');
  });

  it('exits 2 with a clean not-implemented message for a stub command (no stack leak)', async () => {
    const { io, out, err } = captureIo();
    expect(await run(argv('init'), io)).toBe(2); // `init` is still a stub (2.J landed `create`)
    expect(err()).toContain('not available yet');
    // No stack frame as primary output — a Node frame line is `    at …` (string check, no regex).
    const hasStackFrame = err()
      .split('\n')
      .some((line) => line.trimStart().startsWith('at '));
    expect(hasStackFrame).toBe(false);
    expect(out()).toBe(''); // human errors go to stderr, stdout stays clean
  });

  it('emits the structured JSON error envelope on stderr under --json, stdout empty (ADR-0049)', async () => {
    const { io, out, err } = captureIo();
    const code = await run(argv('init', '--json'), io); // `init` is still a stub (2.J landed `create`)
    expect(code).toBe(2);
    expect(out()).toBe(''); // stdout stays pure: a CLI fault is a stderr diagnostic
    const parsed: unknown = JSON.parse(err().trim());
    expect(isErrorEnvelope(parsed)).toBe(true);
    if (isErrorEnvelope(parsed)) {
      expect(parsed.type).toBe('error');
      expect(parsed.code).toBe('not_implemented');
    }
  });

  it('exits 2 when --verbose and --quiet are combined', async () => {
    const { io, err } = captureIo();
    expect(await run(argv('--verbose', '--quiet', 'list'), io)).toBe(2);
    expect(err()).toContain('cannot be combined');
  });

  it('renders the JSON error envelope on stderr when --json precedes a failing global flag', async () => {
    const { io, out, err } = captureIo();
    expect(await run(argv('--json', '--cwd'), io)).toBe(2);
    expect(out()).toBe('');
    const parsed: unknown = JSON.parse(err().trim());
    expect(isErrorEnvelope(parsed)).toBe(true);
    if (isErrorEnvelope(parsed)) {
      expect(parsed.type).toBe('error');
      expect(parsed.code).toBe('invalid_invocation');
    }
  });

  it('renders a commander parse error as a JSON envelope on stderr under --json, stdout empty', async () => {
    const { io, out, err } = captureIo();
    expect(await run(argv('--json', 'bogus'), io)).toBe(2);
    expect(out()).toBe(''); // stdout stays pure NDJSON territory — never a fault envelope
    const parsed: unknown = JSON.parse(err().trim()); // commander's own human message is suppressed
    expect(isErrorEnvelope(parsed)).toBe(true);
    if (isErrorEnvelope(parsed)) {
      expect(parsed.type).toBe('error');
      expect(parsed.code).toBe('invalid_invocation');
      expect(parsed.message.startsWith('error:')).toBe(false); // commander's prefix stripped
    }
  });

  it('treats a lone -- as a bare invocation (prints help, exits 0)', async () => {
    const { io, out } = captureIo();
    expect(await run(argv('--'), io)).toBe(0);
    expect(out()).toContain('Usage: relavium');
  });
});
