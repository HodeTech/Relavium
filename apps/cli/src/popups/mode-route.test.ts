/**
 * Which `/mode` lines the one routing sends to the `/mode` popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6; MVP-11 unit 8, OD-25): the bare command, white space around it ignored, on a settings port that holds the member of its surface: a
 * CHAT's member on a chat's port, the HOME's member on the bare Home's. A typed mode (`/mode plan`) is dispatched and applies directly; a port
 * without the member (a plain chat has no port at all) dispatches the line; and a member never crosses surfaces: a chat's member on the bare Home
 * (there is no conversation for its `Enter` to apply to) and the Home's on a chat (it could only write the startup default) open nothing.
 */
import { describe, expect, it } from 'vitest';

import { routePopupLine } from './popup-route.js';
import { settingsAvailable, type ModeSettingsPort, type SettingsPort } from './settings-port.js';

const MODE: ModeSettingsPort = {
  scope: 'chat',
  current: () => 'ask',
  apply: () => true,
  startup: () => 'ask',
  saveStartupDefault: () => Promise.resolve({ kind: 'said' }),
};
const HOME_MODE: ModeSettingsPort = {
  scope: 'home',
  startup: () => 'ask',
  saveStartupDefault: () => Promise.resolve({ kind: 'said' }),
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

  it('the bare Home’s /mode is the popup on a port that holds the HOME’s member, and never on one that holds a chat’s', () => {
    for (const line of ['/mode', '  /mode  '])
      expect(routePopupLine(line, { doctor: false, settings: portOn('home', HOME_MODE) })).toEqual({
        kind: 'settings',
        command: 'mode',
      });
    const chatMemberOnHome = portOn('home', MODE);
    expect(settingsAvailable(chatMemberOnHome, 'mode')).toBe(false);
    expect(routePopupLine('/mode', { doctor: true, settings: chatMemberOnHome })).toBeUndefined();
    expect(
      routePopupLine('/mode plan', { doctor: false, settings: portOn('home', HOME_MODE) }),
    ).toBeUndefined();
    expect(settingsAvailable(portOn('home-chat', MODE), 'mode')).toBe(true);
  });

  it('a chat never opens the Home’s member (it could only write the startup default)', () => {
    for (const surface of ['home-chat', 'standalone-chat'] as const) {
      expect(settingsAvailable(portOn(surface, HOME_MODE), 'mode')).toBe(false);
      expect(
        routePopupLine('/mode', { doctor: false, settings: portOn(surface, HOME_MODE) }),
      ).toBeUndefined();
    }
  });
});
