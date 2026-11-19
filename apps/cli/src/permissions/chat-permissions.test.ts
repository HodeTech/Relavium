import { describe, expect, it, vi } from 'vitest';

import { ApprovalCache } from '../chat/chat-mode.js';
import { chatPermissionsNotice, type ChatPermissionsDeps } from './chat-permissions.js';
import type { CommandGrantStore, ListResult, RevokeResult } from './command-grants.js';

/** `/permissions` (ADR-0118 §2): the project's remembered commands and this session's approvals, and withdrawing one. */
const PATH_PROGRAMS = new Set(['npm', 'git']);
const findProgram = (name: string): Promise<string | undefined> =>
  Promise.resolve(PATH_PROGRAMS.has(name) ? `/usr/bin/${name}` : undefined);

function deps(options: {
  readonly list?: ListResult;
  readonly revoke?: RevokeResult;
  readonly noStore?: boolean;
  readonly session?: readonly (readonly string[])[];
}): ChatPermissionsDeps & {
  readonly cache: ApprovalCache;
  readonly revoke: ReturnType<typeof vi.fn>;
} {
  const cache = new ApprovalCache();
  for (const argv of options.session ?? []) cache.rememberAlwaysCommand(argv);
  const revoke = vi.fn(() => options.revoke ?? ({ ok: false, reason: 'no-such-grant' } as const));
  const grants: Pick<CommandGrantStore, 'list' | 'revoke'> = {
    list: () => options.list ?? { ok: true, grants: [] },
    revoke,
  };
  return {
    grants: options.noStore === true ? undefined : grants,
    session: cache,
    findProgram,
    cache,
    revoke,
  };
}
const request = (change: Partial<{ revoke: boolean; session: boolean; number: string }> = {}) => ({
  revoke: false,
  session: false,
  number: undefined,
  ...change,
});

describe('/permissions lists', () => {
  it('both kinds, numbered, with a program name only where it could be named, and never an argument', async () => {
    const d = deps({
      list: {
        ok: true,
        grants: [
          { index: 1, id: 'a', program: 'npm', args: 1, grantedAt: '2026-11-19T12:00:00.000Z' },
          {
            index: 2,
            id: 'b',
            program: '(unnamed program)',
            args: 3,
            grantedAt: '2026-11-19T12:05:00.000Z',
          },
        ],
      },
      session: [
        ['git', 'push', 'SECRET-TOKEN'],
        ['./deploy.sh', '--prod'],
      ],
    });
    const text = await chatPermissionsNotice(request(), d);
    expect(text).toBe(
      [
        'Remembered for this project (2):',
        '  1. npm  (1 argument)  remembered 2026-11-19T12:00:00.000Z',
        '  2. (unnamed program)  (3 arguments)  remembered 2026-11-19T12:05:00.000Z',
        'Approved for this session (2):',
        '  1. git  (2 arguments)',
        '  2. (unnamed program)  (1 argument)',
        'Withdraw one with /permissions --revoke <number>, or /permissions --revoke --session <number> for a session approval.',
      ].join('\n'),
    );
    expect(text).not.toContain('SECRET-TOKEN');
    expect(text).not.toContain('deploy');
  });

  it('says none for an empty list, and that remembered commands are unavailable where the chat has no store', async () => {
    expect(await chatPermissionsNotice(request(), deps({}))).toContain(
      'Remembered for this project: none.',
    );
    expect(await chatPermissionsNotice(request(), deps({}))).toContain(
      'Approved for this session: none.',
    );
    expect(await chatPermissionsNotice(request(), deps({ noStore: true }))).toContain(
      'Remembered for this project: not available in this chat.',
    );
  });

  it.each([
    ['no-key', 'OS keychain'],
    ['unreadable', 'revoke --all'],
  ] as const)(
    'reports a store that cannot be read (%s) with its way out, and still lists the session',
    async (reason, phrase) => {
      const text = await chatPermissionsNotice(
        request(),
        deps({ list: { ok: false, reason }, session: [['npm', 'test']] }),
      );
      expect(text).toContain(phrase);
      expect(text).toContain('1. npm  (1 argument)');
    },
  );
});

describe('/permissions --revoke', () => {
  it('withdraws a remembered command by its number and says which one', async () => {
    const d = deps({ revoke: { ok: true, id: 'a', program: 'npm', args: 1 } });
    const text = await chatPermissionsNotice(request({ revoke: true, number: '2' }), d);
    expect(d.revoke).toHaveBeenCalledExactlyOnceWith(2);
    expect(text).toBe(
      'Revoked remembered command 2: npm, 1 argument. It asks again the next time it is needed. The numbers have changed: /permissions lists them.',
    );
  });

  it('withdraws a session approval with --session, so the same command asks again', async () => {
    const d = deps({
      session: [
        ['git', 'status'],
        ['npm', 'test'],
      ],
    });
    const text = await chatPermissionsNotice(
      request({ revoke: true, session: true, number: '1' }),
      d,
    );
    expect(text).toBe('Withdrew session approval 1: git  (1 argument). It asks again.');
    expect(d.cache.isAlwaysCommand(['git', 'status'])).toBe(false);
    expect(d.cache.isAlwaysCommand(['npm', 'test']), 'the other one stays').toBe(true);
    expect(d.revoke).not.toHaveBeenCalled();
  });

  it.each([undefined, '0', '01', '-1', '1.5', 'x', '1234567', ''])(
    'refuses the number %j without touching anything',
    async (number) => {
      const d = deps({ session: [['npm', 'test']] });
      const text = await chatPermissionsNotice(
        request({ revoke: true, ...(number === undefined ? {} : { number }) }),
        d,
      );
      expect(text).toContain('Give the number to withdraw');
      expect(d.revoke).not.toHaveBeenCalled();
      expect(d.cache.commandApprovals()).toHaveLength(1);
    },
  );

  it('a number that names nothing is said plainly, for both kinds', async () => {
    expect(await chatPermissionsNotice(request({ revoke: true, number: '9' }), deps({}))).toBe(
      'There is no remembered command with that number. /permissions lists them.',
    );
    expect(
      await chatPermissionsNotice(request({ revoke: true, session: true, number: '9' }), deps({})),
    ).toBe('There is no session approval with that number. /permissions lists them.');
  });

  it.each([
    ['unwritable', 'could not be written'],
    ['full', 'no room'],
    ['no-key', 'OS keychain'],
    ['unreadable', 'could not be read'],
  ] as const)('a revoke that could not happen (%s) says so', async (reason, phrase) => {
    const text = await chatPermissionsNotice(
      request({ revoke: true, number: '1' }),
      deps({ revoke: { ok: false, reason } }),
    );
    expect(text).toContain(phrase);
  });

  it('with no store a remembered revoke is unavailable, while a session one still works', async () => {
    const d = deps({ noStore: true, session: [['npm', 'test']] });
    expect(await chatPermissionsNotice(request({ revoke: true, number: '1' }), d)).toBe(
      'Remembered commands are not available in this chat.',
    );
    expect(
      await chatPermissionsNotice(request({ revoke: true, session: true, number: '1' }), d),
    ).toContain('Withdrew session approval 1');
  });
});

describe('the session approvals of the approval cache', () => {
  it('are listed in the order given, round-trip exactly, and a withdrawn one is gone', () => {
    const cache = new ApprovalCache();
    cache.rememberAlwaysCommand(['cat', 'a b']);
    cache.rememberAlwaysCommand(['cat', 'a', 'b']);
    expect(cache.commandApprovals()).toEqual([
      ['cat', 'a b'],
      ['cat', 'a', 'b'],
    ]);
    expect(cache.forgetCommandApproval(1)).toEqual(['cat', 'a b']);
    expect(cache.isAlwaysCommand(['cat', 'a b'])).toBe(false);
    expect(cache.isAlwaysCommand(['cat', 'a', 'b'])).toBe(true);
    expect(cache.forgetCommandApproval(5)).toBeUndefined();
    expect(cache.forgetCommandApproval(0)).toBeUndefined();
  });
});
