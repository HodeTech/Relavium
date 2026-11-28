/**
 * The reset of a card's evidence when a popup takes the keyboard over it ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): synchronously, whenever a NEW popup becomes the top of the stack (it opened, or a child opened), and not when one closes.
 */
import { describe, expect, it, vi } from 'vitest';

import { revokeCardCustodyOnPopup } from './custody.js';
import { createPopupHost } from './popup-host.js';
import type { PopupContext } from './popup-host.js';
import type { PopupSpec } from './popup-reducer.js';

const spec = (id: string): PopupSpec => ({
  id,
  title: `/${id}`,
  origin: 'home',
  steps: [
    {
      name: 'One',
      content: { kind: 'empty', what: 'Nothing.', next: 'Close it.' },
      controls: [{ key: 'r', verb: 'again' }],
    },
  ],
});

describe('revokeCardCustodyOnPopup', () => {
  it('resets when a popup opens and when a child opens over it, synchronously, and not when either closes', () => {
    let now = 0;
    const host = createPopupHost({ placement: 'overlay', now: () => now, settleMs: 0 });
    host.bindVisibility(() => true);
    host.bindOpenGate(() => undefined); // an unbound gate opens nothing
    const revoke = vi.fn();
    const stop = revokeCardCustodyOnPopup(host, revoke);
    expect(revoke).not.toHaveBeenCalled();
    let opener: PopupContext | undefined;
    host.openForUser(spec('one'), { control: (context) => (opener = context) });
    expect(revoke, 'in the same call that opened it').toHaveBeenCalledTimes(1);
    host.shown(host.getSnapshot());
    now = 10;
    host.input('', { downArrow: true });
    expect(revoke, 'a move is not a new popup').toHaveBeenCalledTimes(1);
    host.input('r', {});
    opener?.openChild(spec('two'));
    expect(revoke).toHaveBeenCalledTimes(2);
    host.input('', { escape: true });
    host.input('', { escape: true });
    expect(host.getSnapshot().open).toBe(false);
    expect(revoke).toHaveBeenCalledTimes(2);
    stop();
    host.openForUser(spec('three'));
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('resets at once when it starts watching a host that already has a popup open', () => {
    const host = createPopupHost({ placement: 'overlay' });
    host.bindOpenGate(() => undefined); // an unbound gate opens nothing
    host.openForUser(spec('one'));
    const revoke = vi.fn();
    revokeCardCustodyOnPopup(host, revoke);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
