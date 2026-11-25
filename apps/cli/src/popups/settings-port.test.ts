/**
 * The settings port's eager half and its routing ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6): one table of the four settings; only the bare command is a settings line (a typed value applies through the dispatch, an argument a
 * command does not take is rejected there); a setting is routed only where the host's port can open it (`/effort` only on a model with a tier);
 * the one routing (`routePopupLine`) learns the settings beside the doctor and the reports; and the opener table opens `/effort` and, for a
 * setting whose member the port does not hold, opens nothing and says nothing.
 */
import { describe, expect, it } from 'vitest';

import { routePopupLine } from './popup-route.js';
import {
  parseSettingsLine,
  SETTINGS,
  settingsAvailable,
  type SettingsKind,
  type SettingsPort,
} from './settings-port.js';
import { fakeEffort, settingsRig } from './settings.test-support.js';

const KINDS = [
  'mode',
  'effort',
  'models',
  'permissions',
] as const satisfies readonly SettingsKind[];

const port = (over: Partial<SettingsPort> = {}): SettingsPort => ({
  surface: 'standalone-chat',
  announce: () => {},
  ...over,
});

const withEffort = (tiers: readonly ('off' | 'low' | 'medium' | 'high' | 'max')[]) =>
  port({ effort: fakeEffort('claude-sonnet-4-6', tiers, undefined).member });

describe('the one table', () => {
  it('holds the four settings in order, each named by its command, the two that take a value marked so', () => {
    expect(SETTINGS.map((row) => [row.kind, row.command, row.argument])).toEqual([
      ['mode', '/mode', 'applies'],
      ['effort', '/effort', 'applies'],
      ['models', '/models', 'rejected'],
      ['permissions', '/permissions', 'rejected'],
    ]);
  });
});

describe('parseSettingsLine: only the bare command', () => {
  it.each(KINDS)('`/%s` and white space around it is a settings line', (kind) => {
    expect(parseSettingsLine(`/${kind}`)).toEqual({ kind });
    expect(parseSettingsLine(`  /${kind}  `)).toEqual({ kind });
  });

  it.each([
    '/mode plan',
    '/effort high',
    '/effort on',
    '/models gpt-5',
    '/permissions all',
    '/mode  auto  ',
    '/effortx',
    '/Effort',
    'effort',
    '/cost',
    '',
  ])('`%s` is not', (line) => {
    expect(parseSettingsLine(line)).toBeUndefined();
  });
});

describe('settingsAvailable: a member that can open', () => {
  it('`/effort` needs its member AND a tier to choose', () => {
    expect(settingsAvailable(port(), 'effort')).toBe(false);
    expect(settingsAvailable(withEffort([]), 'effort')).toBe(false);
    expect(settingsAvailable(withEffort(['high']), 'effort')).toBe(true);
  });

  it.each(['mode', 'models', 'permissions'] as const)(
    '`/%s` cannot open from a port that does not hold its member (only `/effort` is wired here)',
    (kind) => {
      expect(settingsAvailable(withEffort(['low', 'high']), kind)).toBe(false);
    },
  );
});

describe('the one routing learns the settings', () => {
  const settings = withEffort(['low', 'high']);

  it('a bare `/effort` routes to the settings popup where the port can open it', () => {
    expect(routePopupLine('/effort', { doctor: false, settings })).toEqual({
      kind: 'settings',
      command: 'effort',
    });
    expect(routePopupLine(' /effort ', { doctor: true, settings })).toEqual({
      kind: 'settings',
      command: 'effort',
    });
  });

  it('a typed value, a model with no tier, a host with no settings port, and a setting whose member the port does not hold are not routed', () => {
    expect(routePopupLine('/effort high', { doctor: false, settings })).toBeUndefined();
    expect(routePopupLine('/effort', { doctor: false, settings: withEffort([]) })).toBeUndefined();
    expect(routePopupLine('/effort', { doctor: false })).toBeUndefined();
    for (const line of ['/mode', '/models', '/permissions'])
      expect(routePopupLine(line, { doctor: true, settings })).toBeUndefined();
  });

  it('the doctor and the reports still route as before beside it', () => {
    expect(routePopupLine('/doctor', { doctor: true, settings })).toEqual({
      kind: 'doctor',
      deep: false,
    });
    expect(
      routePopupLine('/help', {
        doctor: false,
        reports: { surface: 'home-chat', help: { keys: [] } },
        settings,
      }),
    ).toEqual({ kind: 'report', line: { kind: 'help' } });
  });
});

describe('the opener table', () => {
  it('opens `/effort` with its member, and nothing without it (a wiring mistake: no notification)', () => {
    const r = settingsRig();
    expect(r.open({}, 'effort')).toEqual({ opened: false, reason: 'closed' });
    expect(r.notifications.getSnapshot().current).toBeUndefined();
    const effort = fakeEffort('claude-sonnet-4-6', ['low', 'high'], 'low');
    expect(r.open({ effort: effort.member }, 'effort').opened).toBe(true);
    expect(r.host.getSnapshot().frame?.spec.id).toBe('effort');
  });

  it.each(['mode', 'models', 'permissions'] as const)(
    '`/%s` without its member opens nothing and says nothing (a wiring mistake, never reachable from a typed line)',
    (kind) => {
      const r = settingsRig();
      const effort = fakeEffort('claude-sonnet-4-6', ['low', 'high'], 'low');
      expect(r.open({ effort: effort.member }, kind)).toEqual({ opened: false, reason: 'closed' });
      expect(r.host.getSnapshot().open).toBe(false);
      expect(r.notifications.getSnapshot().current).toBeUndefined();
    },
  );

  it('a refused open is the host’s answer passed on whole (one notification, nothing applied)', () => {
    const r = settingsRig();
    r.host.bindOpenGate(() => 'turn-running');
    const effort = fakeEffort('claude-sonnet-4-6', ['low', 'high'], 'low');
    expect(r.open({ effort: effort.member }, 'effort')).toEqual({
      opened: false,
      reason: 'turn-running',
    });
    expect(r.notifications.getSnapshot().current?.text).toBe(
      '/effort cannot open now: a turn is running',
    );
    expect(effort.applied).toEqual([]);
  });
});
