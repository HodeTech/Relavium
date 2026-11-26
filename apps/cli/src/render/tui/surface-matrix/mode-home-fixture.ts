import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStartingModeRuntime } from '../../../chat/starting-mode.js';
import { loadResolvedConfig } from '../../../config/load.js';
import { runHomeModeSettings } from '../../../popups/mode-home.js';
import { KEYS, type HomeMount, type NativePromptChannel } from './home-host.js';
import { pinnedNativePopupBox, recordNativePopups } from './native-popup-recorder.js';
import { recordBaseline } from './popup-fixture.js';
import type { PopupBox } from './properties.js';
import type { HomeSurface } from './surface-types.js';
import type { Variant } from './variants.js';

/**
 * The bare Home's `/mode` popup (ADR-0148 §1, §3, §6; MVP-11 Appendix A), in its three steps: the choice of the startup default, the `Ctrl+Y`
 * confirmation (what is written, to which file, what stays) and the Done step that names the file. Each is the product's own run function
 * (`runHomeModeSettings`) on the channel the Home wires, over a temporary operator home whose config the real writer writes (nothing is
 * written elsewhere), driven through the guards the person's answers pass: the process's own clock is moved on by what the guards need instead
 * of waited for. Each is checked as every popup is: its box from the slot's own geometry over the snapshot the channel shows NOW, the overlay
 * layer, the dimmed backdrop, and its legend row whole on one row.
 */

/** The channel of the cell that is open now: the popup box is computed from what it shows (cells run one after another). */
let current: NativePromptChannel | undefined;

function channelOf(m: HomeMount): NativePromptChannel {
  if (m.channel === undefined) throw new Error('the surface needs a native prompt channel');
  current = m.channel;
  recordNativePopups(m.channel);
  return m.channel;
}

/** Whether the prompt on the channel now is the frame on the terminal, measured and flushed. */
function shownOn(channel: NativePromptChannel): boolean {
  try {
    channel.ui.assertVisible(channel.ui.getSnapshot());
    return true;
  } catch {
    return false;
  }
}

/** Where the framed prompt the channel shows now is drawn in a cell, and its rows: the slot's own geometry and frame lines over it. */
function liveModeBox(variant: Variant): PopupBox {
  if (current === undefined) throw new Error('no flow is open');
  return pinnedNativePopupBox(current, current.ui.getSnapshot(), variant);
}

/** The guards of an answer (the opening settle, a chord card's dwell and its lockout), passed by moving the process clock on. */
const GUARDS_PASSED_MS = 2600;
let clockSkipped = 0;
let clockInstalled: (() => number) | undefined;
function skipClock(m: HomeMount): void {
  if (clockInstalled === undefined) {
    const real = performance.now.bind(performance);
    clockInstalled = real;
    performance.now = (): number => real() + clockSkipped;
    m.defer(() => {
      performance.now = real;
      clockInstalled = undefined;
      clockSkipped = 0;
    });
  }
  clockSkipped += GUARDS_PASSED_MS;
}

/** The popup as far as `upTo`, over a temporary operator home (global default `ask`) removed when the cell ends. */
async function openModeTo(m: HomeMount, upTo: 'choice' | 'confirm' | 'done'): Promise<void> {
  const channel = channelOf(m);
  const root = mkdtempSync(join(tmpdir(), 'relavium-matrix-mode-'));
  m.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  const cwd = join(home, 'project');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, '.relavium', 'config.toml'), '[preferences]\ndefault_mode = "ask"\n');
  runHomeModeSettings({
    runtime: createStartingModeRuntime(loadResolvedConfig({ cwd, home }), true),
    cwd,
    interactive: true,
    flow: channel.flow,
    target: '~/.relavium/config.toml',
    assertAdmitting: () => {},
    publish: (prepared, assertAdmitting) => prepared.publish(assertAdmitting),
  }).catch(() => undefined);
  const shownKind = (kind: string): Promise<boolean> =>
    m.until(() => channel.ui.getSnapshot().kind === kind && shownOn(channel));
  // Below the floor nothing is ever on screen: the notice stays, and nothing is answered.
  if (!(await shownKind('select')) || upTo === 'choice') return;
  skipClock(m);
  m.key(KEYS.down); // → plan
  await m.until(() => channel.ui.getSnapshot().selected === 1 && shownOn(channel));
  m.key(KEYS.enter);
  if (!(await shownKind('chord')) || upTo === 'confirm') return;
  skipClock(m);
  m.key(KEYS.ctrlY);
  await m.until(() => channel.ui.getSnapshot().final !== undefined && shownOn(channel));
}

const NATIVE = { nativePrompt: true } as const;
const NOTES =
  'the body behind the popup: the empty, keyed landing; the flow is the product’s own run function on the channel the Home wires, over a temporary operator home, its guards passed by moving the process clock on';

function modeSurface(
  entry: Pick<HomeSurface, 'id' | 'title' | 'landmark' | 'legendRow' | 'selectedRow'>,
  upTo: 'choice' | 'confirm' | 'done',
): HomeSurface {
  return {
    host: 'home',
    exitKey: 'Esc',
    belowFloor: /too small for this popup/iu,
    popup: liveModeBox,
    setup: NATIVE,
    notes: NOTES,
    ...entry,
    open: async (m) => {
      recordBaseline(m);
      await openModeTo(m, upTo);
    },
  };
}

export const MODE_HOME_SURFACES: readonly HomeSurface[] = [
  modeSurface(
    {
      id: 'home.mode-flow',
      title: 'The /mode popup on the bare Home: the choice of the startup default',
      landmark: 'Choose a global startup default',
      selectedRow: 'ask  asks before each write',
      legendRow: '↑/↓ select · Enter choose · Esc close',
    },
    'choice',
  ),
  modeSurface(
    {
      id: 'home.mode-confirm',
      title:
        'The /mode popup on the bare Home: the confirmation (what is written, to which file), the Ctrl+Y chord step',
      landmark: 'Save plan as the global startup default?',
    },
    'confirm',
  ),
  modeSurface(
    {
      id: 'home.mode-done',
      title:
        'The /mode popup on the bare Home: its Done step (the startup default saved, the file)',
      landmark: 'Startup default: plan',
      legendRow: 'Enter / Esc close',
    },
    'done',
  ),
];
