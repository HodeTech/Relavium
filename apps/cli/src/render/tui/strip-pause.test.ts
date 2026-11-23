/**
 * When the strip's idle tick does not read ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6), pure: every condition is pinned alone against a quiet landing, so a condition that is dropped from the predicate fails its own
 * test and no other condition can cover for it. `home-strip-refresh.test.ts` drives the same conditions through the real controller.
 */
import { describe, expect, it } from 'vitest';

import { stripRefreshPaused, type StripPauseFacts } from './strip-pause.js';

/** The landing with nothing in front of it, on a terminal that is big enough. */
const QUIET: StripPauseFacts = {
  mode: 'home',
  screen: false,
  palette: false,
  modelPicker: false,
  effortPicker: false,
  permissionsSheet: false,
  search: false,
  mention: false,
  exitGuard: false,
  nativeActionBusy: false,
  terminal: { columns: 80, rows: 24 },
};

describe('the idle tick is not paused on a quiet landing', () => {
  it('reads on an 80×24 terminal, on a bigger one, and before the host has told the Home its size', () => {
    expect(stripRefreshPaused(QUIET)).toBe(false);
    expect(stripRefreshPaused({ ...QUIET, terminal: { columns: 200, rows: 60 } })).toBe(false);
    expect(stripRefreshPaused({ ...QUIET, terminal: undefined })).toBe(false);
  });
});

describe('each condition pauses it alone', () => {
  it.each([
    ['a chat in front', { mode: 'chat' }],
    ['the build before a chat', { mode: 'loading' }],
    ['a screen in front (run view, card, tab host, help sheet)', { screen: true }],
    ['the command palette', { palette: true }],
    ['the model picker', { modelPicker: true }],
    ['the effort overlay', { effortPicker: true }],
    ['the permissions sheet', { permissionsSheet: true }],
    ['the reverse search', { search: true }],
    ['the @-mention completion', { mention: true }],
    ['the exit question', { exitGuard: true }],
    ['a native form', { nativeActionBusy: true }],
  ] as const satisfies readonly (readonly [string, Partial<StripPauseFacts>])[])(
    'paused by %s, with everything else quiet',
    (_name, over) => {
      expect(stripRefreshPaused({ ...QUIET, ...over })).toBe(true);
    },
  );

  it.each([
    [79, 24],
    [80, 23],
    [79, 23],
    [20, 5],
    [0, 0],
  ] as const)('paused below 80×24, at %i×%i', (columns, rows) => {
    expect(stripRefreshPaused({ ...QUIET, terminal: { columns, rows } })).toBe(true);
  });
});
