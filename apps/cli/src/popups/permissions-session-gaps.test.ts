/**
 * `/permissions` when the host refuses to open it ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6), which `permissions-session.test.ts` leaves open (found by the step-5 round-1 mutation sweep): a popup the host's open gate refuses (a
 * turn is running) opens nothing, reads nothing, and throws nothing: the refusal is the result, not a crash on the context a refused open does not
 * have.
 */
import { describe, expect, it, vi } from 'vitest';

import type { PermissionsPort, PermissionsSnapshot } from '../permissions/chat-permissions.js';
import { settingsRig } from './settings.test-support.js';

describe('a `/permissions` the host’s open gate refuses', () => {
  it('returns the refusal, opens nothing and reads nothing, and never throws', () => {
    const snapshot: PermissionsSnapshot = { project: { ok: true, rows: [] }, session: [] };
    const load = vi.fn(() => snapshot);
    const port: PermissionsPort = { surface: 'chat', load, withdraw: vi.fn() };
    const r = settingsRig();
    r.host.bindOpenGate(() => 'turn-running');
    let result: ReturnType<typeof r.open> | undefined;
    expect(() => {
      result = r.open({ permissions: { port, mode: () => 'ask' } }, 'permissions');
    }).not.toThrow();
    expect(result).toEqual({ opened: false, reason: 'turn-running' });
    expect(r.host.getSnapshot().open).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
});
