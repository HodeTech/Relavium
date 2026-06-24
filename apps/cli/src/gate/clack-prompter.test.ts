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

  it('cancelling the rejection-comment prompt returns null (no half-built decision)', async () => {
    const d = await createClackGatePrompter(
      deps({ confirm: () => Promise.resolve(false), text: () => Promise.resolve(CANCEL) }),
    ).prompt(gate());
    expect(d).toBeNull();
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

  it('the card defaults to auto-reject when the gate has a deadline but no timeoutAction', async () => {
    const note = vi.fn<(message: string, title: string) => void>();
    await createClackGatePrompter(deps({ note })).prompt(
      gate({ expiresAt: '2026-06-24T11:00:00.000Z' }), // timeoutAction omitted → `?? 'reject'`
    );
    expect(note.mock.calls[0]?.[0]).toContain('auto-reject');
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
    expect(body).toContain('auto-reject');
  });
});
