/**
 * The consent gate
 * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §1, §2, §6, §7).
 *
 * Each case names the §10 acceptance item it satisfies. The one that matters most is the first: "nothing was
 * spawned" is proven with a COUNTER at the process boundary, not by reading a state flag, because a flag only
 * proves the code believes it did not spawn.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { McpServerRef } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import {
  assertStdioConsent,
  createConsentGate,
  mcpConsentPath,
  type ConsentSubject,
} from './mcp-consent-gate.js';

let home = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'relavium-gate-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const globalOptions = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  json: false,
  color: false,
  cwd: process.cwd(),
  configPath: undefined,
  verbosity: 'normal',
  ...over,
});

/** A stdio ref naming a binary that genuinely exists, so resolution is not the thing under test. */
const ref = (over: Partial<McpServerRef> = {}): McpServerRef => ({
  id: 'fs',
  transport: 'stdio',
  command: 'node',
  ...over,
});

/** An `io` whose TTY signals are settable — the four-way interactivity precondition is the point of several. */
function io(
  over: { stdoutIsTty?: boolean; stdinIsTty?: boolean; env?: Record<string, string> } = {},
) {
  const captured = captureIo();
  return {
    ...captured,
    io: {
      ...captured.io,
      stdoutIsTty: over.stdoutIsTty ?? true,
      stdinIsTty: over.stdinIsTty ?? true,
      env: over.env ?? {},
    },
  };
}

describe('createConsentGate — the adapter the five surfaces actually wire', () => {
  // Every other case in this file calls `assertStdioConsent` directly, which is how the production adapter
  // came to DROP its third parameter with nothing noticing: `StdioConsentGate` takes `(refs, cwd, artifact)`,
  // the adapter returned a two-parameter function, and TypeScript accepts a shorter parameter list wherever a
  // longer one is expected. Both callers passed an artifact that vanished at runtime.
  it('FORWARDS the artifact to the prompt, rather than silently dropping it', async () => {
    const { io: cliIo } = io();
    let asked = 0;
    let seen: string | undefined;
    const gate = createConsentGate({
      io: cliIo,
      global: globalOptions(),
      homeDir: home,
      prompt: (subject: ConsentSubject) => {
        asked += 1;
        seen = subject.artifact;
        return Promise.resolve(true);
      },
    });
    await gate([ref()], process.cwd(), '/w/downloaded.agent.yaml');
    expect(asked).toBe(1); // else `seen === undefined` would pass for a prompt that never ran
    expect(seen).toBe('/w/downloaded.agent.yaml');
  });

  it('still refuses, records and resolves exactly as the underlying gate does', async () => {
    const { io: cliIo } = io();
    const gate = createConsentGate({
      io: cliIo,
      global: globalOptions(),
      homeDir: home,
      prompt: () => Promise.resolve(false),
    });
    await expect(gate([ref()], process.cwd(), undefined)).rejects.toSatisfy(isCliError);
    expect(existsSync(mcpConsentPath(home))).toBe(false); // a refusal records nothing
  });
});

describe('assertStdioConsent — nothing spawns without a decision (ADR-0084 §1)', () => {
  it('REPORTS an unreadable grant store instead of silently re-asking (§5)', async () => {
    // §5 folds the whole store closed on any unparseable line, because a truncated one may be a TOMBSTONE.
    // That is the safe outcome, but a silent one leaves the user re-approving every server they already
    // approved with no idea why — so the fold is announced on stderr, naming the file they can inspect.
    const store = mcpConsentPath(home);
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, '{"v":1,"digest":"v1:aaa"\n'); // a truncated line, as a crash mid-append leaves
    const { io: cliIo, err } = io();
    await assertStdioConsent([ref()], process.cwd(), {
      io: cliIo,
      global: globalOptions(),
      homeDir: home,
      prompt: () => Promise.resolve(true),
    });
    expect(err()).toContain('could not be read');
    expect(err()).toContain(store);
  });

  it('refuses a declaration carrying a LONE SURROGATE rather than crashing (§10.15)', async () => {
    // §3 refuses it "at parse": the string has no UTF-8 encoding, so a non-TypeScript implementation of the
    // same digest could not hold it. The refusal must be a typed one — an escaping `NonCanonicalValueError`
    // renders as an internal error and tells the author nothing about their own declaration.
    const { io: cliIo } = io();
    let asked = 0;
    await expect(
      assertStdioConsent([ref({ args: ['\ud800'] })], process.cwd(), {
        io: cliIo,
        global: globalOptions(),
        homeDir: home,
        prompt: () => {
          asked += 1;
          return Promise.resolve(true);
        },
      }),
    ).rejects.toSatisfy((error) => isCliError(error) && /lone surrogate/.test(error.message));
    expect(asked).toBe(0);
  });

  it('a network-only declaration needs no consent and asks nothing (§10.19)', async () => {
    const { io: cliIo } = io();
    let asked = 0;
    const resolved = await assertStdioConsent(
      [{ id: 'api', transport: 'http', url: 'https://example.com/mcp' }],
      process.cwd(),
      {
        io: cliIo,
        global: globalOptions(),
        homeDir: home,
        prompt: () => {
          asked += 1;
          return Promise.resolve(true);
        },
      },
    );
    expect(asked).toBe(0);
    expect(resolved.size).toBe(0);
  });

  it('approving records a grant, and a second invocation does not ask again (§10.2, §10.3)', async () => {
    const { io: cliIo } = io();
    let asked = 0;
    const deps = {
      io: cliIo,
      global: globalOptions(),
      homeDir: home,
      now: () => '2026-08-20T00:00:00.000Z',
      prompt: (): Promise<boolean> => {
        asked += 1;
        return Promise.resolve(true);
      },
    };
    await assertStdioConsent([ref()], process.cwd(), deps);
    expect(asked).toBe(1);
    await assertStdioConsent([ref()], process.cwd(), deps);
    expect(asked).toBe(1); // the grant answered the second time
  });

  it('declining refuses the run, and records NOTHING (§10.2)', async () => {
    const { io: cliIo } = io();
    await expect(
      assertStdioConsent([ref()], process.cwd(), {
        io: cliIo,
        global: globalOptions(),
        homeDir: home,
        prompt: () => Promise.resolve(false),
      }),
    ).rejects.toMatchObject({ code: 'invalid_invocation' });
    // A declined server must not leave a grant behind — the next invocation asks again.
    expect(() => readFileSync(mcpConsentPath(home), 'utf8')).toThrow();
  });

  it('a DIFFERENT directory asks again — consent is project-scoped (§3)', async () => {
    const { io: cliIo } = io();
    const asked: ConsentSubject[] = [];
    const deps = {
      io: cliIo,
      global: globalOptions(),
      homeDir: home,
      now: () => '2026-08-20T00:00:00.000Z',
      prompt: (subject: ConsentSubject): Promise<boolean> => {
        asked.push(subject);
        return Promise.resolve(true);
      },
    };
    await assertStdioConsent([ref()], process.cwd(), deps);
    await assertStdioConsent([ref()], home, deps);
    expect(asked).toHaveLength(2);
    // …and the second prompt SAYS where the first approval happened, which is what makes a project-scoped
    // re-ask a recognition rather than a fresh decision.
    expect(asked[1]?.previouslyApprovedIn).toBeDefined();
  });
});

describe('non-interactive: refuse with the digest, never prompt (ADR-0084 §6)', () => {
  const cases: readonly (readonly [string, Parameters<typeof io>[0], Partial<GlobalOptions>])[] = [
    ['no TTY stdout', { stdoutIsTty: false }, {}],
    ['no TTY stdin — a piped credential drains it', { stdinIsTty: false }, {}],
    ['--json owns stdout as a machine stream', {}, { json: true }],
    ['CI, even with both TTYs attached', { env: { CI: 'true' } }, {}],
  ];

  it.each(cases)('%s → exit 2, nothing asked (§10.10)', async (_label, ioOver, globalOver) => {
    // All four signals, and stdout alone is not enough: a question in a machine-readable stream breaks
    // ADR-0049's contract, and `CI=true` with a pseudo-TTY would hang a pipeline on a question nobody answers.
    const { io: cliIo, err } = io(ioOver);
    let asked = 0;
    const error: unknown = await assertStdioConsent([ref()], process.cwd(), {
      io: cliIo,
      global: globalOptions(globalOver),
      homeDir: home,
      prompt: () => {
        asked += 1;
        return Promise.resolve(true);
      },
    }).catch((caught: unknown) => caught);
    expect(asked).toBe(0);
    expect(isCliError(error) && error.code).toBe('invalid_invocation');
    // The DETAIL is on stderr as its own lines and the message is one line: `renderError` collapses every
    // newline in a message to a space, so a multi-line one arrived as a run-on with the digest — the one
    // thing a CI author must copy — buried mid-line.
    expect(err()).toMatch(/v1:[0-9a-f]{64}/);
    expect(isCliError(error) && error.message).not.toContain('\n');
    expect(isCliError(error) && error.message).toContain('--allow-mcp-stdio');
  });

  it('the printed digest is exactly what `--allow-mcp-stdio` accepts (§10.9)', async () => {
    // Asserted by feeding the printed value back in — the loop a CI author actually walks.
    const { io: cliIo, err } = io({ stdoutIsTty: false });
    const deps = { io: cliIo, global: globalOptions(), homeDir: home };
    const error: unknown = await assertStdioConsent([ref()], process.cwd(), deps).catch(
      (caught: unknown) => caught,
    );
    expect(isCliError(error)).toBe(true);
    const digest = /v1:[0-9a-f]{64}/.exec(err())?.[0];
    expect(digest).toBeDefined();
    await expect(
      assertStdioConsent([ref()], process.cwd(), {
        ...deps,
        allowedDigests: [digest ?? ''],
      }),
    ).resolves.toBeDefined();
  });

  it('`--allow-mcp-stdio` writes NO grant (§10.11)', async () => {
    // A flag is how a CI definition states its own trust; a shared runner that accumulated grants would
    // slowly agree to everything anyone ran on it.
    const { io: cliIo, err } = io({ stdoutIsTty: false });
    const deps = { io: cliIo, global: globalOptions(), homeDir: home };
    await assertStdioConsent([ref()], process.cwd(), deps).catch(() => undefined);
    const digest = /v1:[0-9a-f]{64}/.exec(err())?.[0] ?? '';
    await assertStdioConsent([ref()], process.cwd(), { ...deps, allowedDigests: [digest] });
    expect(() => readFileSync(mcpConsentPath(home), 'utf8')).toThrow();
  });
});

describe('what the prompt is given (ADR-0084 §7)', () => {
  it('shows the resolved executable, each argument separately, and the env with authored values', async () => {
    const { io: cliIo } = io();
    let subject: ConsentSubject | undefined;
    await assertStdioConsent(
      [ref({ args: ['--flag', 'a b'], env: { ACME_TOKEN: '{{secrets.acme}}', PLAIN: 'v' } })],
      process.cwd(),
      {
        io: cliIo,
        global: globalOptions(),
        homeDir: home,
        now: () => '2026-08-20T00:00:00.000Z',
        prompt: (given: ConsentSubject) => {
          subject = given;
          return Promise.resolve(true);
        },
      },
    );
    expect(subject?.resolvedCommand.startsWith('/')).toBe(true);
    expect(subject?.authoredCommand).toBe('node'); // shown because it differs from the resolved path
    // One entry per argument — never a joined shell string, because argument boundaries are exactly what an
    // escape sequence or a bidi override would blur. `'a b'` is the case that proves it.
    expect(subject?.args).toEqual(['--flag', 'a b']);
    // The env is shown, because it is the half of a declaration that changes what an executable does — with
    // a secret reference as a MARKER, never a resolved credential.
    expect(subject?.env).toEqual([
      ['ACME_TOKEN', '<secret:acme>'],
      ['PLAIN', 'v'],
    ]);
  });

  it('SANITIZES every displayed field (§10.16)', async () => {
    // `command`, `args` and the env names are artifact-controlled, and a prompt showing a different command
    // than the one that will run is precisely the attack this gate exists to prevent.
    const { io: cliIo } = io();
    let subject: ConsentSubject | undefined;
    await assertStdioConsent(
      [ref({ id: 'fs', args: ['\u001b[2Jwiped', '\u202edrowssap'] })],
      process.cwd(),
      {
        io: cliIo,
        global: globalOptions(),
        homeDir: home,
        now: () => '2026-08-20T00:00:00.000Z',
        prompt: (given: ConsentSubject) => {
          subject = given;
          return Promise.resolve(true);
        },
      },
    );
    const rendered = JSON.stringify(subject);
    expect(rendered).not.toContain('\\u001b');
    expect(rendered).not.toContain('\\u202e');
  });

  it('states the COUNT once before the first question (§2)', async () => {
    // Two genuinely DIFFERENT declarations. An earlier version of this test used two ids naming a
    // byte-identical one and pinned "2 local programs" — asserting exactly the behaviour §10.18 forbids.
    const { io: cliIo, err } = io();
    await assertStdioConsent(
      [ref({ id: 'a' }), ref({ id: 'b', args: ['--different'] })],
      process.cwd(),
      {
        io: cliIo,
        global: globalOptions(),
        homeDir: home,
        now: () => '2026-08-20T00:00:00.000Z',
        prompt: () => Promise.resolve(true),
      },
    );
    expect(err()).toContain('2 local programs');
  });

  it('two ids naming the SAME declaration prompt ONCE and record ONE grant (§10.18)', async () => {
    // Two agents in one artifact commonly declare the same server. It is one program and one decision; the
    // first implementation asked twice and appended two lines for one digest.
    const { io: cliIo, err } = io();
    let asked = 0;
    await assertStdioConsent([ref({ id: 'a' }), ref({ id: 'b' })], process.cwd(), {
      io: cliIo,
      global: globalOptions(),
      homeDir: home,
      now: () => '2026-08-20T00:00:00.000Z',
      prompt: () => {
        asked += 1;
        return Promise.resolve(true);
      },
    });
    expect(asked).toBe(1);
    expect(err()).not.toContain('local programs'); // the count line is for a PLURAL decision
    const lines = readFileSync(mcpConsentPath(home), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(1);
  });
});

describe('resolution failures refuse before anything is asked (ADR-0084 §3)', () => {
  it('an unresolvable command is exit 2, and no prompt happens', async () => {
    const { io: cliIo } = io();
    let asked = 0;
    const error: unknown = await assertStdioConsent(
      [ref({ command: 'definitely-not-a-real-binary-xyz' })],
      process.cwd(),
      {
        io: cliIo,
        global: globalOptions(),
        homeDir: home,
        prompt: () => {
          asked += 1;
          return Promise.resolve(true);
        },
      },
    ).catch((caught: unknown) => caught);
    expect(asked).toBe(0);
    expect(isCliError(error) && error.code).toBe('invalid_invocation');
  });
});
