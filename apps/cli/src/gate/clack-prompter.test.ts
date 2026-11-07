import type { HumanGatePausedEvent } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { createClackGatePrompter, type ClackPromptDeps } from './clack-prompter.js';

const CANCEL = Symbol('clack:cancel');

function deps(over: Partial<ClackPromptDeps> = {}): ClackPromptDeps {
  return {
    note: vi.fn(),
    confirm: vi.fn(() => Promise.resolve(true)),
    text: vi.fn(() => Promise.resolve('')),
    isCancel: (v): v is symbol => v === CANCEL,
    ...over,
  };
}

function gate(over: Partial<HumanGatePausedEvent> = {}): HumanGatePausedEvent {
  return {
    type: 'human_gate:paused',
    runId: 'run-1',
    timestamp: '2026-06-24T10:00:00.000Z',
    sequenceNumber: 1,
    nodeId: 'review',
    gateId: 'g1',
    gateType: 'approval',
    message: 'Ship it?',
    ...over,
  };
}

describe('createClackGatePrompter', () => {
  it('renders a card from the event (title carries the gate type + node id)', async () => {
    const note = vi.fn<(message: string, title: string) => void>();
    await createClackGatePrompter(deps({ note })).prompt(gate());
    expect(note).toHaveBeenCalledTimes(1);
    const [body, title] = note.mock.calls[0] ?? [];
    expect(title).toContain('Approval gate');
    expect(title).toContain('review');
    expect(body).toContain('Ship it?');
  });

  it('sanitizes the card body and title while retaining readable multiline gate text (G44)', async () => {
    const attack = '\x1b[2J\x1b]52;c;Zm9v\x07\x1bPtmux;\x1b\\\x9b2J\r\b\u202E';
    const note = vi.fn<(message: string, title: string) => void>();
    await createClackGatePrompter(deps({ note })).prompt(
      gate({
        nodeId: `node visible${attack}\nforged title row`,
        message: `message visible${attack}\nsecond message line`,
      }),
    );

    const [body, title] = note.mock.calls[0] ?? [];
    for (const forbidden of ['\x1b', '\x9b', '\r', '\b', '\u202E']) {
      expect(body).not.toContain(forbidden);
      expect(title).not.toContain(forbidden);
    }
    expect(body).toContain('message visible');
    expect(body).toContain('second message line');
    expect(title).toContain('node visible');
    expect(title).not.toContain('\n'); // a title cannot forge another terminal row
  });

  it('uses the no-message fallback after controls are stripped (not before)', async () => {
    const note = vi.fn<(message: string, title: string) => void>();
    await createClackGatePrompter(deps({ note })).prompt(
      gate({ message: '\x1b]52;c;Zm9v\x07\u202E' }),
    );
    expect(note.mock.calls[0]?.[0]).toBe('(no message)');
  });

  it('never prints a forged runtime timeout action on the deadline card', async () => {
    const note = vi.fn<(message: string, title: string) => void>();
    const event = gate({
      expiresAt: '2026-06-24T11:00:00.000Z',
      timeoutAction: 'reject',
    });
    // Events are schema-validated at the bus boundary, but the renderer itself must remain safe when a host or
    // test double violates that contract. Reflect simulates that runtime condition without weakening TypeScript types.
    expect(
      Reflect.set(
        event,
        'timeoutAction',
        'reject\x1b]52;c;Zm9v\x07\x9b2J\u202E\nforged timeout row',
      ),
    ).toBe(true);

    await createClackGatePrompter(deps({ note })).prompt(event);

    const body = note.mock.calls[0]?.[0] ?? '';
    for (const forbidden of ['\x1b', '\x9b', '\r', '\b', '\u202E']) {
      expect(body).not.toContain(forbidden);
    }
    // The action is only compared, never interpolated: anything but `approve` reads as the default.
    expect(body).toContain('the run fails on timeout');
    expect(body).not.toContain('forged timeout row');
    expect(body.split('\n')).toHaveLength(3); // message + blank separator + one deadline row
  });

  it('approval gate → approve yields an approved decision', async () => {
    const d = await createClackGatePrompter(deps({ confirm: () => Promise.resolve(true) })).prompt(
      gate(),
    );
    expect(d).toEqual({ decision: 'approved', decidedBy: 'cli' });
  });

  it('approval gate → reject collects an optional comment', async () => {
    const d = await createClackGatePrompter(
      deps({ confirm: () => Promise.resolve(false), text: () => Promise.resolve('too risky') }),
    ).prompt(gate());
    expect(d).toEqual({ decision: 'rejected', decidedBy: 'cli', comment: 'too risky' });
  });

  it('a blank rejection comment is dropped', async () => {
    const d = await createClackGatePrompter(
      deps({ confirm: () => Promise.resolve(false), text: () => Promise.resolve('   ') }),
    ).prompt(gate());
    expect(d).toEqual({ decision: 'rejected', decidedBy: 'cli' });
  });

  it('cancelling the confirm (Ctrl-C / ESC) returns null', async () => {
    const d = await createClackGatePrompter(
      deps({ confirm: () => Promise.resolve(CANCEL) }),
    ).prompt(gate());
    expect(d).toBeNull();
  });

  /** A watcher reporting whether the key that ended the prompt was Ctrl-C (Clack reports Esc and Ctrl-C alike). */
  const pressed =
    (interrupted: boolean): NonNullable<ClackPromptDeps['watchInterrupt']> =>
    async (prompt) => ({ value: await prompt(), interrupted });

  it('Esc at the optional rejection reason keeps the rejection, without a reason', async () => {
    const d = await createClackGatePrompter(
      deps({
        confirm: () => Promise.resolve(false),
        text: () => Promise.resolve(CANCEL),
        watchInterrupt: pressed(false),
      }),
    ).prompt(gate());
    expect(d).toEqual({ decision: 'rejected', decidedBy: 'cli' });
  });

  it('Ctrl-C at the optional rejection reason cancels the run, as at the card', async () => {
    const d = await createClackGatePrompter(
      deps({
        confirm: () => Promise.resolve(false),
        text: () => Promise.resolve(CANCEL),
        watchInterrupt: pressed(true),
      }),
    ).prompt(gate());
    expect(d).toBeNull();
  });

  it('a typed reason stands even when the watcher saw Ctrl-C earlier', async () => {
    const d = await createClackGatePrompter(
      deps({
        confirm: () => Promise.resolve(false),
        text: () => Promise.resolve('too risky'),
        watchInterrupt: pressed(true),
      }),
    ).prompt(gate());
    expect(d).toEqual({ decision: 'rejected', decidedBy: 'cli', comment: 'too risky' });
  });

  it('without a key watcher a cancel at the reason is taken as Ctrl-C and cancels the run', async () => {
    const d = await createClackGatePrompter(
      deps({ confirm: () => Promise.resolve(false), text: () => Promise.resolve(CANCEL) }),
    ).prompt(gate());
    expect(d).toBeNull();
  });

  it('an abort during the rejection reason still returns null', async () => {
    const controller = new AbortController();
    const d = await createClackGatePrompter(
      deps({
        confirm: () => Promise.resolve(false),
        text: () => {
          controller.abort();
          return Promise.resolve(CANCEL);
        },
      }),
    ).prompt(gate(), undefined, controller.signal);
    expect(d).toBeNull();
  });

  it('a bare Enter on the approval card rejects: the confirm defaults to Reject', async () => {
    const confirm = vi.fn<ClackPromptDeps['confirm']>(() => Promise.resolve(false));
    await createClackGatePrompter(deps({ confirm, text: () => Promise.resolve('') })).prompt(
      gate(),
    );
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ initialValue: false });
  });

  it('input gate → text value yields an input_provided decision (raw string)', async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const d = await createClackGatePrompter(
      deps({ confirm, text: () => Promise.resolve('us-east-1') }),
    ).prompt(gate({ gateType: 'input', message: 'Region?' }));
    expect(d).toEqual({ decision: 'input_provided', decidedBy: 'cli', payload: 'us-east-1' });
    expect(confirm).not.toHaveBeenCalled(); // input gate never asks approve/reject
  });

  it('input gate → cancel returns null', async () => {
    const d = await createClackGatePrompter(deps({ text: () => Promise.resolve(CANCEL) })).prompt(
      gate({ gateType: 'input' }),
    );
    expect(d).toBeNull();
  });

  it('review gate routes through approve/reject (not a text input)', async () => {
    const text = vi.fn(() => Promise.resolve(''));
    const d = await createClackGatePrompter(
      deps({ confirm: () => Promise.resolve(true), text }),
    ).prompt(gate({ gateType: 'review' }));
    expect(d).toEqual({ decision: 'approved', decidedBy: 'cli' });
    expect(text).not.toHaveBeenCalled(); // approved → no comment prompt
  });

  it('review gate → reject collects a comment, and → cancel returns null', async () => {
    const rejected = await createClackGatePrompter(
      deps({ confirm: () => Promise.resolve(false), text: () => Promise.resolve('looks off') }),
    ).prompt(gate({ gateType: 'review' }));
    expect(rejected).toEqual({ decision: 'rejected', decidedBy: 'cli', comment: 'looks off' });

    const cancelled = await createClackGatePrompter(
      deps({ confirm: () => Promise.resolve(CANCEL) }),
    ).prompt(gate({ gateType: 'review' }));
    expect(cancelled).toBeNull();
  });

  it('a deadline with no timeoutAction fails the run, and the card says so', async () => {
    // The default action is `reject`, and the engine settles a reject deadline as `run_timeout` rather than
    // recording a rejection, so no rejection branch runs.
    const note = vi.fn<(message: string, title: string) => void>();
    await createClackGatePrompter(deps({ note })).prompt(
      gate({ expiresAt: '2026-06-24T11:00:00.000Z' }),
    );
    expect(note.mock.calls[0]?.[0]).toContain('the run fails on timeout');
    expect(note.mock.calls[0]?.[0]).not.toContain('auto-reject');
  });

  it('an approve deadline on an approval or review gate says it approves', async () => {
    for (const gateType of ['approval', 'review'] as const) {
      const note = vi.fn<(message: string, title: string) => void>();
      await createClackGatePrompter(deps({ note })).prompt(
        gate({
          gateType,
          expiresAt: '2026-06-24T11:00:00.000Z',
          timeoutMs: 1000,
          timeoutAction: 'approve',
        }),
      );
      expect(note.mock.calls[0]?.[0]).toContain('auto-approve on timeout');
    }
  });

  it('never promises an input gate it will be approved on timeout: the run fails instead', async () => {
    const note = vi.fn<(message: string, title: string) => void>();
    await createClackGatePrompter(deps({ note, text: () => Promise.resolve('value') })).prompt(
      gate({
        gateType: 'input',
        expiresAt: '2026-06-24T11:00:00.000Z',
        timeoutMs: 1000,
        timeoutAction: 'approve',
      }),
    );
    const [body] = note.mock.calls[0] ?? [];
    expect(body).toContain('the run fails on timeout');
    expect(body).not.toContain('auto-approve');
  });

  it('shows the deadline in the card when the gate has one', async () => {
    const note = vi.fn<(message: string, title: string) => void>();
    await createClackGatePrompter(deps({ note })).prompt(
      gate({
        expiresAt: '2026-06-24T11:00:00.000Z',
        timeoutMs: 3_600_000,
        timeoutAction: 'reject',
      }),
    );
    const [body] = note.mock.calls[0] ?? [];
    expect(body).toContain('Expires at 2026-06-24T11:00:00.000Z');
    expect(body).toContain('the run fails on timeout');
  });
});

describe('budget confirmation from recorded scalar context', () => {
  for (const amount of [0, 20, Number.MAX_SAFE_INTEGER]) {
    it(`binds exactly ${amount} and does not request input/comment`, async () => {
      const d = deps();
      const result = await createClackGatePrompter(d).prompt(
        gate({
          gateType: 'input',
          message: 'PRIVATE_MODEL secret-shaped provenance',
        }),
        { kind: 'amount', microcents: amount },
      );
      expect(result).toEqual({
        decision: 'approved',
        decidedBy: 'cli',
        approvedAmountMicrocents: amount,
      });
      expect(d.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `Approve exactly ${amount} microcents?`,
          initialValue: false, // a bare Enter rejects the spend
        }),
      );
      expect(d.note).toHaveBeenCalledWith(
        expect.stringContaining(`${amount} microcents`),
        expect.stringContaining('Budget gate'),
      );
      expect(d.note).not.toHaveBeenCalledWith(
        expect.stringContaining('PRIVATE_MODEL'),
        expect.anything(),
      );
      expect(d.text).not.toHaveBeenCalled();
    });
  }
  for (const reason of ['unpriced', 'unrepresentable'] as const) {
    it(`offers only rejection/cancel when ${reason}`, async () => {
      const d = deps();
      expect(
        await createClackGatePrompter(d).prompt(gate(), {
          kind: 'reject_only',
          reason,
        }),
      ).toEqual({ decision: 'rejected', decidedBy: 'cli' });
      expect(d.confirm).toHaveBeenCalledWith({
        message: 'Reject this budget gate?',
        active: 'Reject',
        inactive: 'Cancel run',
      });
      expect(d.text).not.toHaveBeenCalled();
      expect(
        await createClackGatePrompter(deps({ confirm: () => Promise.resolve(false) })).prompt(
          gate(),
          { kind: 'reject_only', reason },
        ),
      ).toBeNull();
    });
  }
  it('legacy continuation has no amount and states governance remains installed', async () => {
    const d = deps();
    expect(await createClackGatePrompter(d).prompt(gate(), { kind: 'legacy' })).toEqual({
      decision: 'approved',
      decidedBy: 'cli',
    });
    expect(d.note).toHaveBeenCalledWith(
      expect.stringContaining('current budget checks still apply'),
      expect.anything(),
    );
    // A bare Enter must not continue without an allowance: the confirm defaults to Reject, as the amount card's.
    expect(d.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
  });
  it('amount rejection is binary and cancel never constructs approval', async () => {
    expect(
      await createClackGatePrompter(deps({ confirm: () => Promise.resolve(false) })).prompt(
        gate(),
        { kind: 'amount', microcents: 20 },
      ),
    ).toEqual({ decision: 'rejected', decidedBy: 'cli' });
    expect(
      await createClackGatePrompter(deps({ confirm: () => Promise.resolve(CANCEL) })).prompt(
        gate(),
        { kind: 'amount', microcents: 20 },
      ),
    ).toBeNull();
  });
});
