/**
 * The eager half of `/models` ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2, §3):
 * whether a port can open it (`settingsAvailable`: a chat's member only with the host's switch bound, so the routing never offers a `This
 * chat` that could not switch), and the one binding of that switch (`bindModelSwitch`), which both chat hosts route and open with.
 */
import { describe, expect, it, vi } from 'vitest';

import { fakeModels } from './models.test-support.js';
import { bindModelSwitch, settingsAvailable, type SettingsPort } from './settings-port.js';

const portWith = (models: SettingsPort['models']): SettingsPort => ({
  surface: 'standalone-chat',
  announce: () => {},
  ...(models === undefined ? {} : { models }),
});

describe('settingsAvailable for /models', () => {
  it('a chat’s member opens only with its switch bound; the bare Home’s always; none without a member', () => {
    expect(settingsAvailable(portWith(fakeModels().member), 'models')).toBe(true);
    expect(settingsAvailable(portWith(fakeModels({ noSwitch: true }).member), 'models')).toBe(
      false,
    );
    expect(settingsAvailable(portWith(fakeModels({ scope: 'home' }).member), 'models')).toBe(true);
    expect(settingsAvailable(portWith(undefined), 'models')).toBe(false);
  });
});

describe('bindModelSwitch, the one binding of the host’s switch', () => {
  it('binds the host’s switch into a chat’s member, which the routing then offers', () => {
    const port = portWith(fakeModels({ noSwitch: true }).member);
    const switchModel = vi.fn();
    const bound = bindModelSwitch(port, switchModel);
    expect(bound?.models?.switchModel).toBe(switchModel);
    expect(settingsAvailable(bound ?? port, 'models')).toBe(true);
    // The rest of the port is the session's, untouched.
    expect(bound?.announce).toBe(port.announce);
    expect(bound?.models?.load).toBe(port.models?.load);
  });

  it('a host with no switch withdraws the chat’s member, even one that carried a switch of its own', () => {
    const bound = bindModelSwitch(portWith(fakeModels().member), undefined);
    expect(bound?.models).toBeUndefined();
    expect(settingsAvailable(bound ?? portWith(undefined), 'models')).toBe(false);
  });

  it('leaves the bare Home’s port, a port with no member and no port as they are', () => {
    const home = portWith(fakeModels({ scope: 'home' }).member);
    expect(bindModelSwitch(home, vi.fn())).toBe(home);
    const none = portWith(undefined);
    expect(bindModelSwitch(none, vi.fn())).toBe(none);
    expect(bindModelSwitch(undefined, vi.fn())).toBeUndefined();
  });
});
