/**
 * How a terminal host binds its popup host (`popup-bind.ts`; [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): the acknowledgement is the visibility check, the gate is the open gate, a popup that becomes the top resets the cards, a kind of sheet
 * that ARRIVES closes the open popup unanswered, and the cleanup undoes all of it once. Over a real popup host and fake sources of a sheet.
 */
import { describe, expect, it, vi } from 'vitest';

import { bindPopupHost, watchSheetArrivals, type PopupSheetSources } from './popup-bind.js';
import { createPopupHost, type PopupCloseReason, type PopupRefusal } from './popup-host.js';
import type { PopupSpec } from './popup-reducer.js';

const SPEC: PopupSpec = {
  id: 'test',
  title: '/test',
  origin: 'chat',
  steps: [{ name: 'Pick', content: { kind: 'list', rows: [{ id: 'one', label: 'one' }] } }],
};

type Kind = 'card' | 'native' | 'exitGuard';

/** Sources of a sheet whose kinds a test sets, telling every listener as a store would. */
function fakeSheets(initial: Readonly<Record<Kind, boolean>>) {
  let present = initial;
  const listeners = new Set<() => void>();
  const sources: PopupSheetSources<Kind> = {
    present: () => present,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
  return {
    sources,
    listeners,
    set: (patch: Partial<Record<Kind, boolean>>): void => {
      present = { ...present, ...patch };
      for (const listener of [...listeners]) listener();
    },
  };
}

const NONE: Readonly<Record<Kind, boolean>> = { card: false, native: false, exitGuard: false };

function rig(initial: Readonly<Record<Kind, boolean>> = NONE) {
  const host = createPopupHost({ placement: 'overlay', settleMs: 0 });
  const sheets = fakeSheets(initial);
  const acknowledgement = { visible: vi.fn(() => true), dispose: vi.fn() };
  let refusal: PopupRefusal | undefined;
  const gate = vi.fn(() => refusal);
  const onRevoke = vi.fn();
  const cleanup = bindPopupHost({
    popups: host,
    acknowledgement,
    gate,
    onRevoke,
    watchSheets: sheets.sources,
  });
  const closed: PopupCloseReason[] = [];
  const open = (): boolean =>
    host.openForUser(SPEC, { closed: (reason) => closed.push(reason) }).opened;
  return {
    host,
    sheets,
    acknowledgement,
    gate,
    onRevoke,
    cleanup,
    closed,
    open,
    refuse: (next: PopupRefusal | undefined): void => {
      refusal = next;
    },
  };
}

describe('bindPopupHost', () => {
  it('binds the host’s gate: it is asked at every open and its refusal is the answer', () => {
    const r = rig();
    r.refuse('armed');
    expect(r.host.openForUser(SPEC)).toEqual({ opened: false, reason: 'armed' });
    r.refuse(undefined);
    expect(r.open()).toBe(true);
    expect(r.gate).toHaveBeenCalledTimes(2);
  });

  it('binds the acknowledgement as what the popup host asks whether a frame is on screen', () => {
    const r = rig();
    expect(r.open()).toBe(true);
    r.host.input('x', {});
    expect(r.acknowledgement.visible).toHaveBeenCalledWith(r.host.getSnapshot());
  });

  it('resets the cards when a popup becomes the top, once per popup, synchronously in the open', () => {
    const r = rig();
    expect(r.onRevoke).not.toHaveBeenCalled();
    expect(r.open()).toBe(true);
    expect(r.onRevoke).toHaveBeenCalledTimes(1);
    r.host.closeAll('command');
    expect(r.onRevoke).toHaveBeenCalledTimes(1);
  });

  it.each(['card', 'native', 'exitGuard'] as const)(
    'a %s that arrives while a popup is open closes it unanswered, as a sheet',
    (kind) => {
      const r = rig();
      expect(r.open()).toBe(true);
      r.sheets.set({ [kind]: true });
      expect(r.host.getSnapshot().open).toBe(false);
      expect(r.closed).toEqual(['sheet']);
    },
  );

  it('a sheet that was already there when the popup opened does not close it; one that goes and comes back does', () => {
    const r = rig({ ...NONE, card: true });
    expect(r.open()).toBe(true);
    r.sheets.set({ card: true }); // still there: a change of something else
    expect(r.host.getSnapshot().open).toBe(true);
    r.sheets.set({ native: false });
    expect(r.host.getSnapshot().open).toBe(true);
    r.sheets.set({ card: false }); // it goes: nothing arrives
    expect(r.host.getSnapshot().open).toBe(true);
    r.sheets.set({ card: true }); // it comes back: it arrives
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.closed).toEqual(['sheet']);
  });

  it('a sheet that arrives with no popup open closes nothing, and a popup that opens after it stays', () => {
    const r = rig();
    r.sheets.set({ native: true });
    expect(r.open()).toBe(true);
    r.sheets.set({ exitGuard: false });
    expect(r.host.getSnapshot().open).toBe(true);
  });

  it('the cleanup stops watching and revoking, unbinds the gate (opens are refused as closed) and the visibility check, and disposes once', () => {
    const r = rig();
    expect(r.sheets.listeners.size).toBe(1);
    r.cleanup();
    expect(r.sheets.listeners.size, 'no longer watching the sheets').toBe(0);
    expect(r.acknowledgement.dispose).toHaveBeenCalledTimes(1);
    // The gate is gone: the host refuses every open as `closed`, and the old gate is never asked again.
    expect(r.host.openForUser(SPEC)).toEqual({ opened: false, reason: 'closed' });
    expect(r.gate).not.toHaveBeenCalled();
    // Bound again by hand, the host opens; the old binding resets nothing and sees nothing.
    r.host.bindOpenGate(() => undefined);
    expect(r.open()).toBe(true);
    expect(r.onRevoke).not.toHaveBeenCalled();
    r.host.input('x', {});
    expect(r.acknowledgement.visible).not.toHaveBeenCalled();
    r.sheets.set({ card: true });
    expect(r.host.getSnapshot().open, 'a sheet after the cleanup closes nothing').toBe(true);
    // A second call does nothing more.
    r.cleanup();
    expect(r.acknowledgement.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('watchSheetArrivals', () => {
  it('reads the kinds once at the start and on every change, and returns the unsubscribe', () => {
    const host = createPopupHost({ placement: 'overlay', settleMs: 0 });
    host.bindOpenGate(() => undefined);
    const sheets = fakeSheets(NONE);
    const present = vi.spyOn(sheets.sources, 'present');
    const stop = watchSheetArrivals(host, sheets.sources);
    expect(present).toHaveBeenCalledTimes(1);
    expect(host.openForUser(SPEC).opened).toBe(true);
    stop();
    sheets.set({ card: true });
    expect(host.getSnapshot().open).toBe(true);
    expect(present).toHaveBeenCalledTimes(1);
  });
});
