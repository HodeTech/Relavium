/**
 * The consent gate
 * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §1, §2, §6, §7).
 *
 * Each case names the §10 acceptance item it satisfies. The one that matters most is the first: "nothing was
 * spawned" is proven with a COUNTER at the process boundary, not by reading a state flag, because a flag only
 * proves the code believes it did not spawn.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

import type { McpServerRef } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNativeConsentPrompter } from '../home/consent-card.js';
import { createConsentPrompter } from '../mcp/consent-prompt.js';
import { isCliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { captureIo } from '../test-support.js';
import { appendGrant } from './mcp-consent.js';
import {
  assertStdioConsent,
  CONSENT_PATH_UNSHOWN,
  createConsentGate,
  mcpConsentPath,
  type ConsentPrompter,
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
    // Named from `~`, so a transcript or a screen share does not carry the operator's directory layout away.
    expect(err()).toContain(`~${sep}.relavium${sep}mcp-consent.ndjson could not be read`);
    expect(err()).not.toContain(home);
    // And the way out: a store that cannot be read stays unread (every later approval would be appended and never seen) until the file
    // is deleted or moved aside, which only the person can do.
    expect(err()).toContain('Delete the file or move it aside to start a new grant log.');
  });

  // A symbolic link is not created on every Windows account.
  it.skipIf(process.platform === 'win32')(
    'does NOT honour a grant read through a symbolic link, says so without a path, and refuses to record into it',
    async () => {
      const store = mcpConsentPath(home);
      const deps = {
        global: globalOptions(),
        homeDir: home,
        now: () => '2026-08-20T00:00:00.000Z',
      };
      let asked = 0;
      const prompt = (): Promise<boolean> => {
        asked += 1;
        return Promise.resolve(true);
      };
      const first = io();
      await assertStdioConsent([ref()], process.cwd(), { ...deps, io: first.io, prompt });
      expect(asked).toBe(1);
      expect(first.err()).not.toContain('could not be read'); // a readable store: no warning
      // The store is moved aside and a link to it takes its place: the grant is still readable THROUGH the link.
      const moved = join(home, 'moved-store.ndjson');
      renameSync(store, moved);
      symlinkSync(moved, store);
      const before = readFileSync(moved, 'utf8');

      const second = io();
      await expect(
        assertStdioConsent([ref()], process.cwd(), { ...deps, io: second.io, prompt }),
      ).rejects.toSatisfy(isCliError);
      expect(asked).toBe(2); // the grant behind the link was not honoured, so it asked again
      expect(second.err()).toContain(`~${sep}.relavium${sep}mcp-consent.ndjson could not be read`);
      expect(readFileSync(moved, 'utf8')).toBe(before); // and nothing was written through the link
      // Neither the warning nor the failure that follows the answer names the operator's directory.
      expect(second.err()).not.toContain(home);
      try {
        await assertStdioConsent([ref()], process.cwd(), { ...deps, io: io().io, prompt });
        expect.unreachable('a consent that cannot be recorded must not let the run start');
      } catch (error) {
        if (!isCliError(error)) throw error;
        expect(error.message).toContain(`recorded in ~${sep}.relavium${sep}mcp-consent.ndjson`);
        expect(error.message).toContain('symbolic link');
        expect(error.message).not.toContain(home);
      }
    },
  );

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

describe('a native card answers where the terminal signals do not (ADR-0139 §4)', () => {
  // A hosted leg's `io` reports non-TTY on purpose, so the four-way precondition is false for it. The Home's card is its own host's
  // input owner: it asks, and it is the only prompt a hosted leg can open.
  it('asks through the card with no TTY at all, and never without a prompter', async () => {
    const { io: cliIo } = io({ stdoutIsTty: false, stdinIsTty: false, env: { CI: 'true' } });
    const deps = { io: cliIo, global: globalOptions(), homeDir: home };
    const subjects: string[] = [];
    await assertStdioConsent([ref()], process.cwd(), {
      ...deps,
      nativeCard: true,
      prompt: (subject: ConsentSubject) => {
        subjects.push(subject.serverId);
        return Promise.resolve(true);
      },
    });
    expect(subjects).toEqual(['fs']);

    // The flag alone is not a way to ask: with no card wired the gate refuses with the digest, exactly as for a script.
    const refused: unknown = await assertStdioConsent(
      [ref({ id: 'other', args: ['--other'] })],
      process.cwd(),
      {
        ...deps,
        nativeCard: true,
      },
    ).catch((caught: unknown) => caught);
    expect(isCliError(refused) && refused.message).toContain('--allow-mcp-stdio');
  });

  it('a card that refuses stops the run and writes no grant', async () => {
    const { io: cliIo } = io({ stdoutIsTty: false, stdinIsTty: false });
    const error: unknown = await assertStdioConsent([ref()], process.cwd(), {
      io: cliIo,
      global: globalOptions(),
      homeDir: home,
      nativeCard: true,
      prompt: () => Promise.resolve(false),
    }).catch((caught: unknown) => caught);
    expect(isCliError(error) && error.message).toContain('was not approved');
    expect(() => readFileSync(mcpConsentPath(home), 'utf8')).toThrow();
  });

  it('without the flag the terminal signals still decide, so no other host gains a way to ask', async () => {
    const { io: cliIo } = io({ stdoutIsTty: false });
    let asked = 0;
    await assertStdioConsent([ref()], process.cwd(), {
      io: cliIo,
      global: globalOptions(),
      homeDir: home,
      prompt: () => {
        asked += 1;
        return Promise.resolve(true);
      },
    }).catch(() => undefined);
    expect(asked).toBe(0);
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

// Real files whose names hold a control character are a POSIX fact, and so is the executable bit.
describe.skipIf(process.platform === 'win32')(
  'a path reaches a prompt exactly as it is, or no prompt at all: the Home`s card and the shell`s question (M1 at the gate)',
  () => {
    /**
     * Each makes a different file from its visible twin `srv`. All but the last are what the gate's own sanitizer strips; the soft
     * hyphen is kept by it and drawn by nothing, so the shell would show it raw and the person would read `srv`.
     */
    const HIDDEN: readonly (readonly [string, string])[] = [
      ['U+200B, a zero-width space', '\u200B'],
      ['U+200D, a zero-width joiner', '\u200D'],
      ['U+2060, a word joiner', '\u2060'],
      ['U+FEFF, a byte-order mark', '\uFEFF'],
      ['U+202E, a bidi override', '\u202E'],
      ['0x07, a bell', '\u0007'],
      ['0x1b, an escape', '\u001B'],
      ['U+00AD, a soft hyphen', '\u00AD'],
    ];

    /** What the end of a row draws as nothing: `srv` and `srv ` look the same there. */
    const TRAILING: readonly (readonly [string, string])[] = [
      ['a space', ' '],
      ['U+00A0, a no-break space', '\u00A0'],
      ['U+2800, the Braille blank', '\u2800'],
    ];

    /** Blanks that are not the ordinary space, so `my srv` with one of them reads as `my srv` with a space. */
    const MIDDLE: readonly (readonly [string, string])[] = [
      ['U+00A0, a no-break space', '\u00A0'],
      ['U+2800, the Braille blank', '\u2800'],
      ['U+3000, an ideographic space', '\u3000'],
      ['U+2028, a line separator', '\u2028'],
    ];

    /** The longest path a prompt shows (the gate's `MAX_PATH_CHARS`: what an 80x24 card holds whole for the executable and its directory). */
    const BOUND = 520;

    /** A directory name the secret scrubber masks (the shape of a provider key): a prompt would show `[REDACTED]` where the path has it. */
    const CREDENTIAL_SHAPED = 'sk-ant-api03-Q9zXw7TokenValue12345abcdef';

    /**
     * A real file or directory under `base` whose path, as the gate resolves it, is exactly `length` characters: directories of 200
     * characters (a name's limit is 255), then the last name. Its path is returned.
     */
    function pathOfLength(base: string, length: number, kind: 'file' | 'directory'): string {
      let path = realpathSync(base);
      while (length - path.length > 201) path = join(path, 'd'.repeat(199));
      mkdirSync(path, { recursive: true });
      const last = join(path, 'n'.repeat(length - path.length - 1));
      if (kind === 'directory') mkdirSync(last);
      else executable(last);
      return last;
    }

    /** A production prompter, and every line it put on screen. */
    interface Surface {
      readonly prompt: ConsentPrompter;
      readonly lines: () => readonly string[];
      readonly close: () => Promise<void>;
    }

    /** The Home's consent card on a real native prompt channel; a card that opens is read, then refused by cancelling the flow. */
    function card(): Surface {
      const channel = createNativePromptChannel();
      channel.flow.begin();
      const lines: string[] = [];
      let read: unknown;
      const stop = channel.ui.subscribe(() => {
        const snapshot = channel.ui.getSnapshot();
        if (snapshot.kind !== 'chord' || snapshot === read) return;
        read = snapshot;
        lines.push(snapshot.message, ...snapshot.details);
        queueMicrotask(() => channel.flow.cancel());
      });
      return {
        prompt: createNativeConsentPrompter(channel.flow),
        lines: () => lines,
        close: async () => {
          stop();
          await channel.flow.end();
        },
      };
    }

    /** The shell's clack question, with clack replaced by a recorder that answers no. */
    function shell(): Surface {
      const lines: string[] = [];
      return {
        prompt: createConsentPrompter({
          log: {
            message: (text) => {
              lines.push(...text.split('\n'));
            },
          },
          confirm: (options) => {
            lines.push(options.message);
            return Promise.resolve(false);
          },
          isCancel: (value): value is symbol => typeof value === 'symbol',
        }),
        lines: () => lines,
        close: () => Promise.resolve(),
      };
    }

    const SURFACES = [
      ['the card', card],
      ['the shell', shell],
    ] as const;

    /** A repository with the visible twin `tools/srv` in it: the file a person would inspect, and the one a prompt must not name instead. */
    function repository(): string {
      const repo = join(home, 'repo');
      mkdirSync(join(repo, 'tools'), { recursive: true });
      executable(join(repo, 'tools', 'srv'));
      return repo;
    }

    function executable(path: string): void {
      writeFileSync(path, '#!/bin/sh\nexit 0\n');
      chmodSync(path, 0o755);
    }

    /** Ask through the REAL gate, which resolves the real file. */
    async function ask(surface: Surface, cwd: string, command: string): Promise<unknown> {
      const { io: cliIo } = io();
      try {
        return await assertStdioConsent([ref({ id: 'docs', command })], cwd, {
          io: cliIo,
          global: globalOptions({ cwd }),
          homeDir: home,
          prompt: surface.prompt,
        }).then(
          () => 'resolved',
          (error: unknown) => error,
        );
      } finally {
        await surface.close();
      }
    }

    /** The value of the row `label` starts, with the label and the space after it removed: the same reading on both surfaces. */
    const rowValue = (lines: readonly string[], label: string): string | undefined =>
      lines
        .map((line) => line.trimStart())
        .find((line) => line.startsWith(`${label} `))
        ?.slice(label.length)
        .trimStart();

    function expectRefusedUnseen(outcome: unknown, surface: Surface): void {
      expect(isCliError(outcome) && outcome.code).toBe('invalid_invocation');
      expect(isCliError(outcome) && outcome.message).toBe(CONSENT_PATH_UNSHOWN);
      expect(surface.lines(), 'nothing was put on screen').toEqual([]);
      expect(existsSync(mcpConsentPath(home)), 'no grant was written').toBe(false);
    }

    describe.each(SURFACES)('%s', (_name, surfaceOf) => {
      it('an ordinary program is asked about, its executable and directory rows equal to the paths on disk (the control)', async () => {
        const repo = repository();
        const surface = surfaceOf();
        const outcome = await ask(surface, repo, './tools/srv');
        expect(isCliError(outcome) && outcome.message).toContain('was not approved');
        expect(rowValue(surface.lines(), 'executable')).toBe(
          realpathSync(join(repo, 'tools', 'srv')),
        );
        expect(rowValue(surface.lines(), 'directory')).toBe(realpathSync(repo));
      });

      it.each(HIDDEN)(
        'an executable whose name holds %s is refused: no prompt names its twin',
        async (_label, hidden) => {
          const repo = repository();
          executable(join(repo, 'tools', `srv${hidden}`));
          const surface = surfaceOf();
          expectRefusedUnseen(await ask(surface, repo, `./tools/srv${hidden}`), surface);
        },
      );

      it.each(TRAILING)(
        'an executable whose name ends in %s is refused: the end of a row draws it as nothing',
        async (_label, blank) => {
          const repo = repository();
          executable(join(repo, 'tools', `srv${blank}`));
          const surface = surfaceOf();
          expectRefusedUnseen(await ask(surface, repo, `./tools/srv${blank}`), surface);
        },
      );

      it.each(MIDDLE)(
        'an executable whose name holds %s between its letters is refused: it reads as an ordinary space',
        async (_label, blank) => {
          const repo = repository();
          executable(join(repo, 'tools', 'my srv'));
          executable(join(repo, 'tools', `my${blank}srv`));
          const surface = surfaceOf();
          expectRefusedUnseen(await ask(surface, repo, `./tools/my${blank}srv`), surface);
        },
      );

      it('ordinary spaces between visible characters are shown as they are (the control): `My  Tools/my srv`', async () => {
        const repo = repository();
        mkdirSync(join(repo, 'My  Tools'));
        executable(join(repo, 'My  Tools', 'my srv'));
        const surface = surfaceOf();
        const outcome = await ask(surface, repo, './My  Tools/my srv');
        expect(isCliError(outcome) && outcome.message).toContain('was not approved');
        expect(rowValue(surface.lines(), 'executable')).toBe(
          realpathSync(join(repo, 'My  Tools', 'my srv')),
        );
      });

      it(`an executable path of exactly ${String(BOUND)} characters is shown whole, its file name included`, async () => {
        const program = pathOfLength(repository(), BOUND, 'file');
        const surface = surfaceOf();
        const outcome = await ask(surface, home, program);
        expect(isCliError(outcome) && outcome.message).toContain('was not approved');
        expect(rowValue(surface.lines(), 'executable')).toBe(program);
        expect(program).toHaveLength(BOUND);
      });

      it(`an executable path of ${String(BOUND + 1)} characters is refused, never shown cut`, async () => {
        const program = pathOfLength(repository(), BOUND + 1, 'file');
        const surface = surfaceOf();
        expectRefusedUnseen(await ask(surface, home, program), surface);
      });

      it('an executable path with a part shaped like a credential is refused, not shown with that part masked', async () => {
        const repo = repository();
        mkdirSync(join(repo, CREDENTIAL_SHAPED));
        executable(join(repo, CREDENTIAL_SHAPED, 'srv'));
        const surface = surfaceOf();
        expectRefusedUnseen(await ask(surface, repo, `./${CREDENTIAL_SHAPED}/srv`), surface);
      });

      it.each([...HIDDEN, ...TRAILING])(
        'a directory whose name holds or ends in %s is refused',
        async (_label, hidden) => {
          const program = join(repository(), 'tools', 'srv');
          const cwd = join(home, `project${hidden}`);
          mkdirSync(cwd);
          const surface = surfaceOf();
          expectRefusedUnseen(await ask(surface, cwd, program), surface);
        },
      );

      it(`a directory of ${String(BOUND + 1)} characters is refused`, async () => {
        const program = join(repository(), 'tools', 'srv');
        const surface = surfaceOf();
        expectRefusedUnseen(
          await ask(surface, pathOfLength(home, BOUND + 1, 'directory'), program),
          surface,
        );
      });

      it(`a directory of exactly ${String(BOUND)} characters is shown whole`, async () => {
        const program = join(repository(), 'tools', 'srv');
        const cwd = pathOfLength(home, BOUND, 'directory');
        const surface = surfaceOf();
        const outcome = await ask(surface, cwd, program);
        expect(isCliError(outcome) && outcome.message).toContain('was not approved');
        expect(rowValue(surface.lines(), 'directory')).toBe(cwd);
      });

      describe('the directory of an earlier approval', () => {
        /** A grant for the same program in another directory, as the log would hold it from an earlier version. */
        function approvedIn(directory: string, program: string): void {
          appendGrant(mcpConsentPath(home), {
            v: 1,
            digest: `v1:${'0'.repeat(64)}`,
            command: realpathSync(program),
            args: [],
            envNames: [],
            cwd: directory,
            grantedAt: '2026-11-25T00:00:00.000Z',
          });
        }

        it('an ordinary one is named exactly (the control)', async () => {
          const repo = repository();
          approvedIn('/elsewhere/project', join(repo, 'tools', 'srv'));
          const surface = surfaceOf();
          const outcome = await ask(surface, repo, './tools/srv');
          expect(isCliError(outcome) && outcome.message).toContain('was not approved');
          expect(surface.lines().map((line) => line.trim())).toContain(
            '(you approved this same program in /elsewhere/project)',
          );
        });

        it.each(HIDDEN)('one holding %s is refused', async (_label, hidden) => {
          const repo = repository();
          approvedIn(`/elsewhere/project${hidden}x`, join(repo, 'tools', 'srv'));
          const surface = surfaceOf();
          const outcome = await ask(surface, repo, './tools/srv');
          expect(isCliError(outcome) && outcome.message).toBe(CONSENT_PATH_UNSHOWN);
          expect(surface.lines(), 'nothing was put on screen').toEqual([]);
        });
      });
    });

    describe('the list a script`s author picks a digest from (§6) names the file that runs, never its twin', () => {
      /** Refuse non-interactively; what was written to stderr, and the digest in it. */
      async function listed(
        cwd: string,
        command: string,
      ): Promise<{ err: string; digest: string }> {
        const { io: cliIo, err } = io({ stdoutIsTty: false });
        let asked = 0;
        const outcome = await assertStdioConsent([ref({ id: 'docs', command })], cwd, {
          io: cliIo,
          global: globalOptions({ cwd }),
          homeDir: home,
          prompt: () => {
            asked += 1;
            return Promise.resolve(true);
          },
        }).catch((caught: unknown) => caught);
        expect(isCliError(outcome) && outcome.message).toContain('--allow-mcp-stdio');
        expect(asked).toBe(0);
        return { err: err(), digest: /v1:[0-9a-f]{64}/.exec(err())?.[0] ?? '' };
      }

      it('an ordinary program`s line is the path as it is and the digest, nothing else (the control)', async () => {
        const repo = repository();
        const { err, digest } = await listed(repo, './tools/srv');
        expect(err).toBe(`  docs: ${realpathSync(join(repo, 'tools', 'srv'))}  ${digest}\n`);
      });

      it('a long path within the bound is listed whole, its file name included', async () => {
        const program = pathOfLength(repository(), 300, 'file');
        const { err, digest } = await listed(home, program);
        expect(err).toBe(`  docs: ${program}  ${digest}\n`);
      });

      it.each([
        ['U+200B, a zero-width space', 'srv\u200B', 'srv\\u200B'],
        ['0x1b, an escape', 'srv\u001B[2J', 'srv\\u001B[2J'],
        ['U+202E, a bidi override', 'srv\u202Evil', 'srv\\u202Evil'],
        ['a trailing space', 'srv ', 'srv\\u0020'],
        ['a no-break space between letters', 'my\u00A0srv', 'my\\u00A0srv'],
        ['a backslash beside a hidden character', 'a\\u200B\u200B', 'a\\\\u200B\\u200B'],
      ])(
        'a program whose name holds %s is listed with it escaped and a note, and the listed digest approves it',
        async (_label, name, shown) => {
          const repo = repository();
          executable(join(repo, 'tools', name));
          const { err, digest } = await listed(repo, `./tools/${name}`);
          expect(err).toBe(
            `  docs: ${realpathSync(repo)}/tools/${shown}  ${digest}  (this path holds characters that do not show, written here as \\u escapes; only its digest can approve it)\n`,
          );
          await expect(
            assertStdioConsent([ref({ id: 'docs', command: `./tools/${name}` })], repo, {
              io: io({ stdoutIsTty: false }).io,
              global: globalOptions({ cwd: repo }),
              homeDir: home,
              allowedDigests: [digest],
            }),
            'the digest the list printed is the one that approves the file that runs',
          ).resolves.toBeDefined();
        },
      );

      it('a path past the bound is listed whole, with a note that only its digest approves it', async () => {
        const program = pathOfLength(repository(), BOUND + 80, 'file');
        const { err, digest } = await listed(home, program);
        expect(err).toBe(
          `  docs: ${program}  ${digest}  (no prompt can show this path as it is, so only its digest can approve it)\n`,
        );
      });

      it('a path with a part shaped like a credential is listed with that part masked, and the same note', async () => {
        const repo = repository();
        mkdirSync(join(repo, CREDENTIAL_SHAPED));
        executable(join(repo, CREDENTIAL_SHAPED, 'srv'));
        const { err, digest } = await listed(repo, `./${CREDENTIAL_SHAPED}/srv`);
        expect(err).not.toContain(CREDENTIAL_SHAPED);
        expect(err).toContain('[REDACTED]');
        expect(err).toContain(
          `  ${digest}  (no prompt can show this path as it is, so only its digest can approve it)\n`,
        );
      });
    });
  },
);

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
