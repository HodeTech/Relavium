import { describe, expect, it } from 'vitest';

import type { HomeDeps } from './home/drive-home.js';
import { CliError } from './process/errors.js';
import { EXIT_CODES, type ExitCode } from './process/exit-codes.js';
import type { CliIo } from './process/io.js';
import { CLI_VERSION } from './program.js';
import { run, type OpenHome } from './run.js';
import { captureIo } from './test-support.js';

const argv = (...tokens: string[]): string[] => ['node', 'relavium', ...tokens];

/** An interactive-TTY {@link CliIo}: the bare-invocation Home gate (`shouldOpenHome`) needs both TTYs. */
function interactiveIo(env: Record<string, string | undefined> = {}): {
  io: CliIo;
  out: () => string;
  err: () => string;
} {
  const base = captureIo();
  return { ...base, io: { ...base.io, stdoutIsTty: true, stdinIsTty: true, env } };
}

/** A scripted {@link OpenHome} that records the deps it was handed and returns/throws a sentinel. */
function fakeOpenHome(result: ExitCode | (() => Promise<never>)): {
  openHome: OpenHome;
  calls: () => HomeDeps[];
} {
  const seen: HomeDeps[] = [];
  const openHome: OpenHome = async (deps) => {
    seen.push(deps);
    if (typeof result === 'function') return result();
    return result;
  };
  return { openHome, calls: () => seen };
}

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

// 2.5.B / ADR-0054 — a bare `relavium` opens the interactive Home in a genuine TTY, but EVERY non-interactive
// path (piped, --json, CI) keeps the byte-for-byte help + exit-0 meta-op. The gate predicate `shouldOpenHome`
// is unit-tested on its own; these assert run() ROUTES on it (Home vs help) and never opens the Home otherwise.
describe('run — bare-invocation Home gate', () => {
  it('opens the Home in a genuine TTY and returns its exit code (no help printed)', async () => {
    const { io, out } = interactiveIo();
    const { openHome, calls } = fakeOpenHome(EXIT_CODES.chatEnded); // a sentinel the help path could never return
    expect(await run(argv(), io, openHome)).toBe(EXIT_CODES.chatEnded);
    expect(calls()).toHaveLength(1);
    expect(out()).toBe(''); // the Home renders via ink, not the help meta-op
  });

  it('hands the Home its io + resolved globals (a lone -- still counts as bare)', async () => {
    const { io } = interactiveIo();
    const { openHome, calls } = fakeOpenHome(EXIT_CODES.success);
    await run(argv('--'), io, openHome);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.io).toBe(io);
    expect(calls()[0]?.global.cwd).toBe(process.cwd());
  });

  it('keeps help + exit 0 (never opens the Home) when stdout is not a TTY', async () => {
    const { io, out } = captureIo(); // captureIo is non-TTY (a pipe / redirect)
    const { openHome, calls } = fakeOpenHome(EXIT_CODES.chatEnded);
    expect(await run(argv(), io, openHome)).toBe(0);
    expect(calls()).toHaveLength(0);
    expect(out()).toContain('Usage: relavium');
  });

  it('keeps help + exit 0 (never opens the Home) when stdin is not a TTY', async () => {
    const { io, out } = interactiveIo();
    const nonTtyStdin: CliIo = { ...io, stdinIsTty: false };
    const { openHome, calls } = fakeOpenHome(EXIT_CODES.chatEnded);
    expect(await run(argv(), nonTtyStdin, openHome)).toBe(0);
    expect(calls()).toHaveLength(0);
    expect(out()).toContain('Usage: relavium');
  });

  it('keeps help + exit 0 (never opens the Home) under --json even in a TTY', async () => {
    const { io, out, err } = interactiveIo();
    const { openHome, calls } = fakeOpenHome(EXIT_CODES.chatEnded);
    expect(await run(argv('--json'), io, openHome)).toBe(0);
    expect(calls()).toHaveLength(0);
    expect(out()).toContain('Usage: relavium'); // the --json bare meta-op is human-on-stdout (ADR-0049)
    expect(err()).toBe('');
  });

  it('keeps help + exit 0 (never opens the Home) under CI even in a TTY', async () => {
    const { io, out } = interactiveIo({ CI: 'true' });
    const { openHome, calls } = fakeOpenHome(EXIT_CODES.chatEnded);
    expect(await run(argv(), io, openHome)).toBe(0);
    expect(calls()).toHaveLength(0);
    expect(out()).toContain('Usage: relavium');
  });

  it('renders a Home build/config fault like a command fault (exit 2, stderr, stdout clean)', async () => {
    const { io, out, err } = interactiveIo();
    const { openHome } = fakeOpenHome(() =>
      Promise.reject(new CliError('invalid_invocation', 'home config is broken')),
    );
    expect(await run(argv(), io, openHome)).toBe(2);
    expect(out()).toBe('');
    expect(err()).toContain('home config is broken');
  });

  it('reports an unexpected Home throw generically (exit 1, no raw message/stack leak)', async () => {
    const { io, out, err } = interactiveIo();
    const { openHome } = fakeOpenHome(() => Promise.reject(new Error('internal boom')));
    expect(await run(argv(), io, openHome)).toBe(EXIT_CODES.workflowFailed); // unexpected → exit 1
    expect(out()).toBe('');
    expect(err()).not.toContain('internal boom'); // the raw message is never surfaced
    expect(err()).toContain('unexpected');
  });
});
