import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS, BUILTIN_TOOL_IDS } from './builtins.js';
import { createToolRegistry } from './registry.js';
import type {
  ToolApprovalLiveContext,
  ToolApprovalRequest,
  ToolDispatchContext,
  ToolHost,
} from './types.js';
import { createInMemoryEffectJournal } from '../engine/execution-host.js';
import { redactSecretShapedText } from './bounding.js';

/**
 * What the approval card is given for a command (ADR-0118 §1): the whole command as one quoted line (a shortened target locks
 * Allow until the person has read it), one row per argument, and an event preview that tells `["cat","a b"]` from `["cat","a","b"]`.
 */
const host = {
  process: {
    spawn: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
  },
} as unknown as ToolHost;

async function asked(
  command: string,
  args: readonly string[],
): Promise<{
  readonly request: ToolApprovalRequest;
  readonly live: ToolApprovalLiveContext | undefined;
}> {
  let seen: { request: ToolApprovalRequest; live: ToolApprovalLiveContext | undefined } | undefined;
  const ctx = {
    nodeId: 'n1',
    grantedToolIds: new Set(BUILTIN_TOOL_IDS),
    config: {},
    toolPolicy: { allowedCommands: [] },
    fsScope: 'sandboxed',
    gateApproved: false,
    effects: createInMemoryEffectJournal({ kind: 'run', runId: 'r', nodeId: 'n1', attempt: 1 }),
    effectSlot: 0,
    approval: {
      confirm: (request: ToolApprovalRequest, _signal: unknown, live?: ToolApprovalLiveContext) => {
        seen = { request, live };
        return Promise.resolve({ outcome: 'approve' as const });
      },
    },
  } as unknown as ToolDispatchContext;
  await createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
    { type: 'tool_call', id: 'c1', name: 'run_command', args: { command, args: [...args] } },
    ctx,
  );
  if (seen === undefined) throw new Error('the hook was not asked');
  return seen;
}

describe('the run_command approval preview (ADR-0118 §1)', () => {
  it('target is the whole command as one quoted line, and every argument is its own bare row', async () => {
    const { live } = await asked('cat', ['a b', 'c', '']);
    expect(live?.preview.target).toBe("cat 'a b' c ''");
    // Bare values, the program first: a label would spend a row each on a card that has room for few.
    expect(live?.preview.fields).toEqual([
      { name: '', value: 'cat' },
      { name: '', value: 'a b' },
      { name: '', value: 'c' },
      { name: '', value: '' },
    ]);
  });

  it('keeps a leading or trailing space and a quote visible in the quoted line', async () => {
    const { live } = await asked('echo', [' lead', 'trail ', "it's"]);
    expect(live?.preview.target).toContain("' lead'");
    expect(live?.preview.target).toContain("'trail '");
  });

  it('the event preview and the in-process copy are the quoted line too, so the two shapes of one string differ', async () => {
    const joined = await asked('cat', ['a b']);
    const split = await asked('cat', ['a', 'b']);
    expect(joined.request.preview.command).not.toBe(split.request.preview.command);
    expect(joined.request.unredactedPreview?.command).toBe("cat 'a b'");
    expect(split.request.unredactedPreview?.command).toBe('cat a b');
  });

  it('a program with no arguments is a one-row command', async () => {
    const { live, request } = await asked('ls', []);
    expect(live?.preview.target).toBe('ls');
    expect(live?.preview.fields).toEqual([{ name: '', value: 'ls' }]);
    expect(request.argv).toEqual(['ls']);
  });
});

/**
 * The display copy is scrubbed, and since the line is shell-quoted an embedded quote is rewritten (`'"'"'`), which broke the
 * `key='value'` context the detector reads: half of these forms leaked in the quoted line and were masked in the joined one the
 * display copy was before. The joined projection is the oracle: whatever IT masks, the quoted preview must mask too.
 */
describe('the event preview of a command masks everything the joined projection masks', () => {
  const SECRET = 'S3cr3tValue9Zq';
  const KEYS = ['token', 'password', 'api_key', 'PGPASSWORD', 'client_secret', 'secret', 'auth'];
  const forms = [
    ...KEYS.flatMap((key) => [
      `${key}='${SECRET}'`,
      `${key}="${SECRET}"`,
      `${key}=${SECRET}`,
      `--${key}='${SECRET}'`,
      `--${key}=${SECRET}`,
      `{'${key}': '${SECRET}'}`,
      `{"${key}": "${SECRET}"}`,
      `${key}: '${SECRET}'`,
    ]),
    `Authorization: Bearer ${SECRET}${SECRET}`,
    `postgres://user:${SECRET}@db.example/app`,
  ];

  it('for every form the old projection masked', async () => {
    let compared = 0;
    for (const form of forms) {
      const joined = redactSecretShapedText(['psql', form].join(' '));
      if (!joined.includes('[redacted]') || joined.includes(SECRET)) continue; // the oracle masks nothing here: nothing to preserve
      compared += 1;
      const { request } = await asked('psql', [form]);
      expect(request.preview.command, form).not.toContain(SECRET);
      expect(request.preview.command, form).toContain('[redacted]');
    }
    expect(compared, 'the corpus exercised the oracle').toBeGreaterThan(40);
  });

  it('a secret in the program name or split from its key across two arguments is masked as well', async () => {
    for (const [command, args] of [
      [`./sk-ant-api03-${SECRET}${SECRET}${SECRET}`, ['--version']],
      ['curl', ['--header', `Authorization: Bearer ${SECRET}${SECRET}`]],
      ['tool', ['--password', SECRET]],
    ] as const) {
      const joined = redactSecretShapedText([command, ...args].join(' '));
      const { request } = await asked(command, args);
      if (!joined.includes(SECRET)) expect(request.preview.command).not.toContain(SECRET);
    }
  });

  it('leaves an ordinary command readable', async () => {
    const { request } = await asked('git', ['log', '--oneline', '-n', '5', 'a b']);
    expect(request.preview.command).toBe("git log --oneline -n 5 'a b'");
  });
});
