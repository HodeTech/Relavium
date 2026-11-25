/**
 * Which `/mode` lines the one routing sends to the `/mode` popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6): the bare command, white space around it ignored, on a CHAT's settings port that holds the member. A typed mode (`/mode plan`) is
 * dispatched and applies directly; a port without the member (a plain chat has no port at all) dispatches the line; and the bare Home's `/mode`
 * is never this popup, whatever a port holds: it sets the startup default through its own flow.
 */
import { describe, expect, it } from 'vitest';

import { routePopupLine } from './popup-route.js';
import { settingsAvailable, type ModeSettingsPort, type SettingsPort } from './settings-port.js';

const MODE: ModeSettingsPort = {
  current: () => 'ask',
  apply: () => true,
  saveStartupDefault: () => Promise.resolve({ kind: 'unchanged' }),
};

const portOn = (surface: SettingsPort['surface'], mode?: ModeSettingsPort): SettingsPort => ({
  surface,
  announce: () => {},
  ...(mode === undefined ? {} : { mode }),
});

describe('routing /mode', () => {
  it.each(['home-chat', 'standalone-chat'] as const)(
    'a bare /mode on a %s port with the member opens the popup',
    (surface) => {
      for (const line of ['/mode', '  /mode  '])
        expect(routePopupLine(line, { doctor: false, settings: portOn(surface, MODE) })).toEqual({
          kind: 'settings',
          command: 'mode',
        });
    },
  );

  it('a typed mode, a port without the member and a host with no port dispatch the line', () => {
    const chat = portOn('standalone-chat', MODE);
    for (const line of ['/mode plan', '/mode auto', '/mode  accept-edits'])
      expect(routePopupLine(line, { doctor: false, settings: chat })).toBeUndefined();
    expect(
      routePopupLine('/mode', { doctor: false, settings: portOn('standalone-chat') }),
    ).toBeUndefined();
    expect(routePopupLine('/mode', { doctor: true })).toBeUndefined();
  });

  it('the bare Home’s /mode is never the popup, even on a port that holds the member', () => {
    const home = portOn('home', MODE);
    expect(settingsAvailable(home, 'mode')).toBe(false);
    expect(routePopupLine('/mode', { doctor: true, settings: home })).toBeUndefined();
    expect(settingsAvailable(portOn('home-chat', MODE), 'mode')).toBe(true);
  });
});
