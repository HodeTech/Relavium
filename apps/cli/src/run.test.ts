import { describe, expect, it } from 'vitest';

import type { CliIo } from './process/io.js';
import { run } from './run.js';

function makeIo(): { io: CliIo; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const io: CliIo = {
    writeOut: (text) => {
      outChunks.push(text);
    },
    writeErr: (text) => {
      errChunks.push(text);
    },
    env: {},
    stdoutIsTty: false,
  };
  return { io, out: () => outChunks.join(''), err: () => errChunks.join('') };
}

const argv = (...tokens: string[]): string[] => ['node', 'relavium', ...tokens];

describe('run', () => {
  it('prints help and exits 0 for --help', async () => {
    const { io, out } = makeIo();
    expect(await run(argv('--help'), io)).toBe(0);
    expect(out()).toContain('Usage: relavium');
    expect(out()).toContain('run');
    expect(out()).toContain('Global options');
  });

  it('prints help and exits 0 for a bare invocation', async () => {
    const { io, out } = makeIo();
    expect(await run(argv(), io)).toBe(0);
    expect(out()).toContain('Usage: relavium');
  });

  it('prints the version and exits 0 for --version', async () => {
    const { io, out } = makeIo();
    expect(await run(argv('--version'), io)).toBe(0);
    expect(out()).toContain('0.0.0');
  });

  it('exits 2 for an unknown command', async () => {
    const { io, err } = makeIo();
    expect(await run(argv('bogus'), io)).toBe(2);
    expect(err()).toMatch(/unknown command/i);
  });

  it('exits 2 when a required argument is missing', async () => {
    const { io } = makeIo();
    expect(await run(argv('run'), io)).toBe(2);
  });

  it('exits 2 with a clean not-implemented message for a stub command (no stack leak)', async () => {
    const { io, out, err } = makeIo();
    expect(await run(argv('run', './wf.relavium.yaml'), io)).toBe(2);
    expect(err()).toContain('not available yet');
    expect(err()).not.toMatch(/\s+at\s+.+:\d+:\d+/); // no stack frame as primary output
    expect(out()).toBe(''); // human errors go to stderr, stdout stays clean
  });

  it('emits a structured JSON error envelope on stdout under --json (flag after the subcommand)', async () => {
    const { io, out } = makeIo();
    const code = await run(argv('run', './wf.relavium.yaml', '--json'), io);
    expect(code).toBe(2);
    const parsed = JSON.parse(out().trim()) as { type: string; code: string };
    expect(parsed.type).toBe('error');
    expect(parsed.code).toBe('not_implemented');
  });

  it('exits 2 when --verbose and --quiet are combined', async () => {
    const { io, err } = makeIo();
    expect(await run(argv('--verbose', '--quiet', 'list'), io)).toBe(2);
    expect(err()).toContain('cannot be combined');
  });

  it('renders the JSON error envelope when --json precedes a failing global flag', async () => {
    const { io, out } = makeIo();
    expect(await run(argv('--json', '--cwd'), io)).toBe(2);
    const parsed = JSON.parse(out().trim()) as { type: string; code: string };
    expect(parsed.type).toBe('error');
    expect(parsed.code).toBe('invalid_invocation');
  });

  it('treats a lone -- as a bare invocation (prints help, exits 0)', async () => {
    const { io, out } = makeIo();
    expect(await run(argv('--'), io)).toBe(0);
    expect(out()).toContain('Usage: relavium');
  });
});
