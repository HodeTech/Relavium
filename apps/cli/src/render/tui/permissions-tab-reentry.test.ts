/**
 * The Permissions tab reads its data again every time it is entered
 * ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §3): the remembered
 * commands from the store, and the repository's allowlist from the config, never the snapshot that was shown the last time. A grant another
 * terminal withdrew, or an allowlist an edit changed, while the person was on another tab must not be listed, or offered for withdrawal,
 * when they come back.
 *
 * The port here is the real {@link createPermissionsPort} over a fake store and a fake config, driven through the real Home controller, so
 * what is counted is what the product reads; only the store and the config behind it are scripted.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import {
  createPermissionsPort,
  type RepoAllowlistSource,
} from '../../permissions/chat-permissions.js';
import type { ListResult } from '../../permissions/command-grants.js';
import { createHomeController, type HomeController } from './home-controller.js';
import { SHEET_SETTLE_MS, sheetEntries } from './permissions-sheet.js';

const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};

const grantsOf = (...programs: readonly string[]): ListResult => ({
  ok: true,
  grants: programs.map((program, index) => ({
    index: index + 1,
    id: `id-${program}`,
    program,
    args: 1,
    grantedAt: '2026-11-19T12:00:07.123Z',
  })),
});

/** A Home whose Permissions port is the product's own over a store and a config the test changes between reads. */
function mount(initial: { grants: ListResult; allowlist: RepoAllowlistSource }) {
  let grants = initial.grants;
  let allowlist = initial.allowlist;
  let clock = 1_000;
  const listGrants = vi.fn(() => grants);
  const readAllowlist = vi.fn(() => allowlist);
  const controller = createHomeController({
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => EMPTY },
    permissions: createPermissionsPort(
      {
        grants: {
          list: listGrants,
          revokeById: () => ({ ok: false, reason: 'no-such-grant' }),
          matches: () => false,
        },
        session: undefined,
        allowlist: readAllowlist,
      },
      'project',
    ),
    now: () => clock,
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
  });
  return {
    controller,
    listGrants,
    readAllowlist,
    setGrants: (next: ListResult): void => {
      grants = next;
    },
    setAllowlist: (next: RepoAllowlistSource): void => {
      allowlist = next;
    },
    tick: (ms: number): void => {
      clock += ms;
    },
  };
}

const sheetOf = (c: HomeController) => {
  const screen = c.getSnapshot().screen;
  const sheet = screen?.kind === 'tab-host' ? screen.host.sheet : undefined;
  if (sheet === undefined) throw new Error('the Permissions tab holds no sheet');
  return sheet;
};
const labels = (c: HomeController): string[] =>
  sheetEntries(sheetOf(c).snapshot).map((entry) =>
    entry.kind === 'project' ? entry.row.label : entry.row.text,
  );
const allowlistOf = (c: HomeController) => sheetOf(c).snapshot.allowlist;

describe('entering the Permissions tab again reads it again', () => {
  it('reads the store and the config on opening, and again when another tab is left for it', () => {
    const home = mount({
      grants: grantsOf('npm', 'node'),
      allowlist: { commands: ['git status'], globs: undefined },
    });
    expect(home.controller.openScreen('tab-host', { tab: 'permissions' })).toBe(true);
    expect(home.listGrants).toHaveBeenCalledTimes(1);
    expect(home.readAllowlist).toHaveBeenCalledTimes(1);
    expect(labels(home.controller)).toEqual(['npm, 1 argument', 'node, 1 argument']);

    home.controller.handleKey('', { leftArrow: true });
    expect(home.controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(home.listGrants, 'a placeholder reads nothing').toHaveBeenCalledTimes(1);
    expect(home.readAllowlist).toHaveBeenCalledTimes(1);

    home.controller.handleKey('', { rightArrow: true });
    expect(home.listGrants, 'entered again: the store is read again').toHaveBeenCalledTimes(2);
    expect(home.readAllowlist, 'and the config').toHaveBeenCalledTimes(2);
  });

  it('shows what changed while the tab was away: a grant another terminal withdrew is gone, and a new allowlist entry is there', () => {
    const home = mount({
      grants: grantsOf('npm', 'node'),
      allowlist: { commands: ['git status'], globs: undefined },
    });
    home.controller.openScreen('tab-host', { tab: 'permissions' });
    const first = sheetOf(home.controller).snapshot;
    expect(labels(home.controller)).toHaveLength(2);
    expect(allowlistOf(home.controller)).toMatchObject({ ok: true, commands: ['git status'] });

    home.controller.handleKey('', { tab: true }); // around to Defined
    home.setGrants(grantsOf('node'));
    home.setAllowlist({ commands: ['git status', 'npm test'], globs: ['git *'] });
    home.controller.handleKey('', { tab: true, shift: true }); // and back to Permissions

    expect(sheetOf(home.controller).snapshot, 'a new snapshot, not the held one').not.toBe(first);
    expect(labels(home.controller)).toEqual(['node, 1 argument']);
    expect(allowlistOf(home.controller)).toMatchObject({
      ok: true,
      commands: ['git status', 'npm test'],
      globs: ['git *'],
    });
  });

  it('a row the other terminal withdrew is not offered: the cursor is clamped to the rows that remain', () => {
    const home = mount({
      grants: grantsOf('npm', 'node', 'git'),
      allowlist: { commands: undefined, globs: undefined },
    });
    home.controller.openScreen('tab-host', { tab: 'permissions' });
    home.controller.handleKey('', { downArrow: true });
    home.controller.handleKey('', { downArrow: true });
    expect(sheetOf(home.controller).cursor).toBe(2);
    home.controller.handleKey('', { leftArrow: true });
    home.setGrants(grantsOf('npm'));
    home.controller.handleKey('', { rightArrow: true });
    expect(labels(home.controller)).toEqual(['npm, 1 argument']);
    expect(sheetOf(home.controller).cursor, 'the only row left').toBe(0);
  });

  it('a held key does not carry across: the tab entered again waits out its settle time before it asks about a row', () => {
    const home = mount({
      grants: grantsOf('npm'),
      allowlist: { commands: undefined, globs: undefined },
    });
    home.controller.openScreen('tab-host', { tab: 'permissions' });
    home.tick(SHEET_SETTLE_MS + 100);
    home.controller.handleKey('', { leftArrow: true });
    home.controller.handleKey('', { rightArrow: true });
    home.controller.handleKey('d', {});
    expect(sheetOf(home.controller).armed, 'the first d after entering only waits').toBe(false);
    home.tick(SHEET_SETTLE_MS + 100);
    home.controller.handleKey('d', {});
    expect(sheetOf(home.controller).armed).toBe(true);
  });

  it('a store that fails when the tab is entered shows its sentence instead of the rows it listed before, and keeps the screen open', () => {
    const home = mount({
      grants: grantsOf('npm'),
      allowlist: { commands: undefined, globs: undefined },
    });
    home.controller.openScreen('tab-host', { tab: 'permissions' });
    home.controller.handleKey('', { leftArrow: true });
    home.listGrants.mockImplementation(() => {
      throw new Error('boom');
    });
    home.controller.handleKey('', { rightArrow: true });
    const screen = home.controller.getSnapshot().screen;
    expect(screen?.kind).toBe('tab-host');
    if (screen?.kind !== 'tab-host') throw new Error('the tab host is open');
    // The store threw: the port says so in its own sentence, and the rows of the earlier read are not kept.
    expect(screen.host.sheet?.snapshot.project.ok).toBe(false);
    home.controller.handleKey('', { escape: true });
    expect(home.controller.getSnapshot().screen).toBeUndefined();
  });
});
