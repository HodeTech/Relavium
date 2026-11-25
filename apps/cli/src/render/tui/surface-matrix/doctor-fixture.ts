import type { LlmResult } from '@relavium/llm';

import type { DoctorPort, DoctorSurface } from '../../../popups/doctor-port.js';
import {
  PONG,
  recordingProvider,
  stubProbes,
  stubResolver,
} from '../../../popups/doctor.test-support.js';
import { popupBoxOf } from './popup-fixture.js';
import type { PopupBox } from './properties.js';
import type { Variant } from './variants.js';
import type { PopupFrame } from '../../../popups/popup-reducer.js';
import { KEYS } from './home-host.js';

/**
 * The `/doctor` popup in the surface matrix ([ADR-0148](../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8): its port over a provider seam with no keychain and no network, and what each of its states needs. The popup is opened the way a person
 * opens it (the command typed and its routing in the host), and its box is the frame the host has open, through the one geometry function.
 */

/** How a cell's doctor answers: a key that works, no key at all, a provider that never answers, or a quick tier whose probe throws. */
export type DoctorFixture = 'keyed' | 'keyless' | 'hanging' | 'failing';

const KEY = ['sk', 'ant', 'matrix', 'ABCDEF123456'].join('-');

/** A doctor port for one cell (a fresh scope per cell: nothing is kept from one cell to the next). */
export function doctorPortFor(surface: DoctorSurface, fixture: DoctorFixture): DoctorPort {
  const anthropic = recordingProvider('anthropic', () =>
    fixture === 'hanging' ? new Promise<LlmResult>(() => {}) : Promise.resolve(PONG),
  );
  const seam = stubResolver({
    keys: fixture === 'keyless' ? {} : { anthropic: KEY },
    providers: { anthropic },
  });
  return {
    scope: {},
    surface,
    resultKey: surface === 'home' ? 'home' : 'matrix-session',
    probes: stubProbes(seam.resolver, {
      ...(fixture === 'failing'
        ? {
            globalArtifacts: () => {
              throw new Error('the global folder could not be read');
            },
          }
        : {}),
      // A chat's session reports one connected server; the Home has none (it shows no MCP rows whatever its probes say).
      deepMcp: () =>
        Promise.resolve([{ id: 'mcp:files', label: 'files', status: 'ok', detail: 'connected' }]),
    }),
  };
}

/** The box of the doctor popup the host has open in this cell. */
export const doctorPopupBox = (variant: Variant, live?: PopupFrame): PopupBox =>
  popupBoxOf(live, variant);

/** The words each state of the popup draws and no other surface does. */
export const DOCTOR_LANDMARKS = {
  checks: 'doctor: all checks passed',
  detail: 'Keys stored in the OS keychain can be read.',
  line: 'Sends one small request per provider, with its key, to:',
  running: 'Asking each provider with its key',
  done: 'Deep check, ',
  empty: 'No provider has a key, so the deep check has nothing to send.',
  error: 'The checks could not run.',
} as const;

/** What the `/doctor` popup is opened to: its checks, a row's detail, its line, the deep tier running, done, with nothing to send, or failed. */
export type DoctorState = keyof typeof DOCTOR_LANDMARKS;

export const DOCTOR_FIXTURE: Readonly<Record<DoctorState, DoctorFixture>> = {
  checks: 'keyed',
  detail: 'keyed',
  line: 'keyed',
  running: 'hanging',
  done: 'keyed',
  empty: 'keyless',
  error: 'failing',
};

/**
 * Put the `/doctor` popup in `state` on a mount of any host: the command typed, then the keys a person presses, the popup's clock skipped past
 * its settle time and the line's dwell (the frame is acknowledged by the real renderer first). Below the floor the keys find no frame to act on
 * and the notice stays, as it should.
 */
export async function driveDoctor(
  m: {
    readonly key: (bytes: string) => void;
    readonly settle: () => Promise<void>;
    readonly until: (predicate: () => boolean) => Promise<boolean>;
    readonly frame: () => string[];
    readonly skip: (ms: number) => void;
  },
  type: () => Promise<void>,
  state: DoctorState,
): Promise<void> {
  const shows = (text: string) => (): boolean => m.frame().join('\n').includes(text);
  await type();
  await m.until(shows(state === 'error' ? DOCTOR_LANDMARKS.error : 'doctor:'));
  await m.settle();
  if (state === 'checks' || state === 'error') return;
  m.skip(600);
  if (state === 'detail') {
    m.key(KEYS.enter);
    await m.until(shows(DOCTOR_LANDMARKS.detail));
    return;
  }
  m.key('d');
  await m.until(shows(state === 'empty' ? DOCTOR_LANDMARKS.empty : DOCTOR_LANDMARKS.line));
  await m.settle();
  if (state === 'line' || state === 'empty') return;
  m.skip(900);
  m.key(KEYS.ctrlY);
  await m.until(shows(state === 'running' ? DOCTOR_LANDMARKS.running : DOCTOR_LANDMARKS.done));
  await m.settle();
}
