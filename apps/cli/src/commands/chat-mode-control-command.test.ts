import type { ToolApprovalRequest } from '@relavium/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { realModeControl, type RealModeControl } from './chat-mode-control.test-support.js';

/**
 * The production mode control (what `relavium chat` and the Home both receive) wires the command card (ADR-0118 §1): the card is
 * given the session workspace, the offers and the facts, and a Remember that cannot be written is reported on the chat's notice
 * channel. A stub of the control would not prove any of this.
 */
const REQUEST: ToolApprovalRequest = {
  toolId: 'run_command',
  action: 'process',
  preview: { command: 'npm test' },
  unredactedPreview: { command: 'npm test' },
  argv: ['npm', 'test'],
  commandAdmitted: false,
};
const made: RealModeControl[] = [];
afterEach(async () => {
  for (const control of made.splice(0)) {
    control.store.sealToolPreviews(); // a card still open is cancelled, not answered
    await control.dispose();
  }
});

async function control(remember: ReturnType<typeof vi.fn>) {
  const m = await realModeControl({
    commandGrants: {
      matches: () => false,
      canRemember: () => ({ ok: true }),
      remember,
    },
  });
  made.push(m);
  return m;
}
const notices = (m: RealModeControl): string[] =>
  m.store
    .getSnapshot()
    .state.transcript.flatMap((entry) => (entry.role === 'notice' ? [entry.text] : []));

describe('the chat mode control, command card wiring', () => {
  it('opens the card with the session workspace, the standing and every offer', async () => {
    const m = await control(vi.fn(() => Promise.resolve({ ok: true })));
    const decision = m.policy()?.confirm?.(REQUEST);
    void decision?.catch(() => undefined);
    const approval = m.store.getSnapshot().approval;
    expect(approval?.facts).toEqual({
      standing: 'not-pre-approved',
      runsCode: false,
      protectedPath: false,
      cwd: m.workspace,
      offers: { session: true, remember: true },
    });
    expect(approval?.cacheable, 'the session answer is offered').toBe(true);
  });

  it('a Remember that cannot be written approves the call once and says why on the notice channel', async () => {
    const remember = vi.fn(() => Promise.resolve({ ok: false, reason: 'unwritable' }));
    const m = await control(remember);
    const decision = m.policy()?.confirm?.(REQUEST);
    m.store.answerApproval({ outcome: 'approve', scope: 'remember' });
    expect(await decision).toMatchObject({ outcome: 'approve' });
    expect(remember).toHaveBeenCalledExactlyOnceWith(['npm', 'test']);
    expect(notices(m).join('\n')).toContain(
      'was not remembered because the remembered-commands file could not be written',
    );
  });
});
