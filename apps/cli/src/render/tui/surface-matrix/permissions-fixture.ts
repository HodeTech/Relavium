// The settings popups' code is loaded by a dynamic import the first time a setting is asked for, which a cold test process would spend longer on
// than the matrix's bounded wait for the first frame: the fixture loads it up front, so every cell sees the popup open as a warm process does.
import '../../../popups/settings-session.js';

import type {
  PermissionsPort,
  PermissionsSnapshot,
} from '../../../permissions/chat-permissions.js';
import type { SettingsPort, SettingsSurface } from '../../../popups/settings-port.js';

/**
 * The chat's `/permissions` popup in the surface matrix ([ADR-0137](../../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §2 as a popup, ADR-0148 §10), in the manner of `settings-fixture.ts`: a settings port whose only member is `/permissions`, over a fake port
 * (two remembered commands and one session approval, as `popup-permissions-chat-80x24.png` draws them, or nothing at all), opened the way a
 * person opens it (the command typed, the chat host's own routing). Its box is the frame the host has open (`settingsPopupBox`).
 */

/** What each permissions surface shows once it is open. */
export const PERMISSIONS_LANDMARKS = {
  list: 'This project · remembered (2)',
  armed: 'Withdraw this remembered command?',
  empty: 'Nothing is approved for this session.',
} as const;

export type PermissionsState = keyof typeof PERMISSIONS_LANDMARKS;

/** The legend row of each permissions surface, whole on one row of every cell. */
export const PERMISSIONS_LEGEND_ROW: Readonly<Record<PermissionsState, string>> = {
  list: '↑/↓ select · [d] / Del withdraw (then Enter) · Esc close',
  armed: 'Enter withdraw · Esc keep',
  empty: 'Esc close',
};

const FULL: PermissionsSnapshot = {
  project: {
    ok: true,
    rows: [
      { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-20 09:12Z' },
      { id: 'b', label: 'pnpm, 2 arguments', remembered: '2026-11-21 16:40Z' },
    ],
  },
  session: [
    {
      argv: ['pnpm', 'test', '--filter', '@acme/billing'],
      text: 'pnpm test --filter @acme/billing',
      alsoRemembered: false,
    },
  ],
};

const EMPTY: PermissionsSnapshot = { project: { ok: true, rows: [] }, session: [] };

/** A settings port for one cell: `/permissions` only, in `ask` mode, over the lists of `state` (a withdrawal says it was made, and changes nothing). */
export function permissionsSettingsPortFor(
  surface: SettingsSurface,
  state: PermissionsState,
): SettingsPort {
  const port: PermissionsPort = {
    surface: 'chat',
    load: () => (state === 'empty' ? EMPTY : FULL),
    withdraw: () => ({ tone: 'done', text: 'Withdrawn. Auto mode asks about it again.' }),
  };
  return { surface, announce: () => {}, permissions: { port, mode: () => 'ask' } };
}

/** Put the permissions popup of `state` on a mount of any chat host: `/permissions` typed and routed by the host, then (armed) `[d]` after its settle. */
export async function drivePermissions(
  m: {
    readonly key: (bytes: string) => void;
    readonly settle: () => Promise<void>;
    readonly until: (predicate: () => boolean) => Promise<boolean>;
    readonly frame: () => string[];
    readonly skip: (ms: number) => void;
  },
  type: (line: string) => Promise<void>,
  state: PermissionsState,
): Promise<void> {
  const shows = (text: string) => (): boolean => m.frame().join('\n').includes(text);
  await type('/permissions');
  await m.until(shows(PERMISSIONS_LANDMARKS[state === 'armed' ? 'list' : state]));
  await m.settle();
  if (state !== 'armed') return;
  m.skip(600);
  m.key('d');
  await m.until(shows(PERMISSIONS_LANDMARKS.armed));
  await m.settle();
}
