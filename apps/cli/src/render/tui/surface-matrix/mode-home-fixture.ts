import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStartingModeRuntime } from '../../../chat/starting-mode.js';
import { loadResolvedConfig } from '../../../config/load.js';
import { saveChatStartupDefault } from '../../../popups/mode-confirm.js';
import { saveHomeStartupDefault } from '../../../popups/mode-home.js';
import type { PopupFrame } from '../../../popups/popup-reducer.js';
import { KEYS, type HomeMount, type NativePromptChannel } from './home-host.js';
import { pinnedNativePopupBox, recordNativePopups } from './native-popup-recorder.js';
import { popupBoxOf, recordBaseline } from './popup-fixture.js';
import type { PopupBox } from './properties.js';
import type { HomeSurface } from './surface-types.js';
import type { Variant } from './variants.js';

/**
 * The bare Home's `/mode` popup (ADR-0148 §1, §3, §6; MVP-11 Appendix A; unit 8, OD-25), in its three screens: the LIST of the startup default
 * (the popup host's: `/mode` typed and routed by the Home, the saved default marked `startup`, one step, no rail), then the `Ctrl+Y` confirmation
 * (what is written, to which file, what saving does to it) and the Done step that names the file. The confirmation and the Done step are the product's
 * own run function (`saveHomeStartupDefault`) on the channel the Home wires, over a temporary operator home whose config the real writer writes
 * (nothing is written elsewhere), driven through the guards the person's answers pass: the process's own clock is moved on by what the guards need
 * instead of waited for. Each is checked as every popup is: its box from the slot's own geometry over what is shown NOW, the overlay layer, the
 * dimmed backdrop, and its legend row whole on one row.
 */

/** The channel of the cell that is open now: the popup box is computed from what it shows (cells run one after another). */
let current: NativePromptChannel | undefined;

/** What the confirmation's cells need of the host they run on: the channel, a place to close what a cell opened, the wait and the keys. Both hosts have it. */
export interface SaveMount {
  readonly channel: NativePromptChannel | undefined;
  readonly defer: (cleanup: () => void) => void;
  readonly until: (predicate: () => boolean, maxFlushes?: number) => Promise<boolean>;
  readonly key: (bytes: string) => void;
}

function channelOf(m: SaveMount): NativePromptChannel {
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
export function liveModeBox(variant: Variant): PopupBox {
  if (current === undefined) throw new Error('no flow is open');
  return pinnedNativePopupBox(current, current.ui.getSnapshot(), variant);
}

/** The guards of an answer (the opening settle, a chord card's dwell and its lockout), passed by moving the process clock on. */
const GUARDS_PASSED_MS = 2600;
let clockSkipped = 0;
let clockInstalled: (() => number) | undefined;
function skipClock(m: SaveMount): void {
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

/**
 * The confirmation as far as `upTo`, over a temporary operator home (global default `ask`) removed when the cell ends, as the Home's `Enter` on `plan`
 * or a chat's `[s]` on `plan` hands it over (`origin`): the same flow, framed from where it was opened.
 */
export async function openModeTo(
  m: SaveMount,
  upTo: 'confirm' | 'done',
  origin: 'home' | 'chat' = 'home',
): Promise<void> {
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
  // The flow the list hands the chosen mode to (`plan`): the confirmation is its first prompt.
  const deps = {
    runtime: createStartingModeRuntime(loadResolvedConfig({ cwd, home }), true),
    cwd,
    interactive: true,
    flow: channel.flow,
    target: '~/.relavium/config.toml',
    assertAdmitting: () => {},
    publish: (
      prepared: Parameters<Parameters<typeof saveChatStartupDefault>[0]['publish']>[0],
      assertAdmitting: () => void,
    ) => prepared.publish(assertAdmitting),
  };
  (origin === 'chat'
    ? saveChatStartupDefault(deps, 'plan', 'ask')
    : saveHomeStartupDefault(deps, 'plan')
  ).catch(() => undefined);
  const shownKind = (kind: string): Promise<boolean> =>
    m.until(() => channel.ui.getSnapshot().kind === kind && shownOn(channel));
  // Below the floor nothing is ever on screen: the notice stays, and nothing is answered.
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
  upTo: 'confirm' | 'done',
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

/** The landing's own keys, then `Enter`: the line goes through the Home's routing, which opens the popup the command has. */
async function typeKeys(m: HomeMount, line: string): Promise<void> {
  for (const letter of line) m.controller.handleKey(letter, {});
  m.controller.handleKey('', { return: true });
  await m.settle();
}

/** The box of the list the popup host has open in this cell. */
const modeListBox = (variant: Variant, live?: PopupFrame, locked = false): PopupBox =>
  popupBoxOf(live, variant, undefined, locked);

/** The bare Home's `/mode` LIST: the landing behind it, `/mode` typed and routed, the saved startup default `ask` marked and opened on. */
const MODE_LIST_SURFACE: HomeSurface = {
  host: 'home',
  id: 'home.mode-flow',
  title:
    'The /mode popup on the bare Home: the list of the startup default, one step, the saved one marked',
  exitKey: 'Esc',
  landmark: 'Choose the startup default for new chats.',
  selectedRow: 'every action asks first',
  legendRow: '↑/↓ select · Enter keep · Esc close',
  belowFloor: /too small for this popup/iu,
  popup: modeListBox,
  setup: {
    deps: {
      startupMode: { read: () => 'ask', save: () => Promise.resolve({ kind: 'closed' }) },
    },
  },
  notes:
    'the body behind the popup: the empty, keyed landing; the popup is opened by typing /mode, through the Home’s routing; the saved default is ask (its Enter keeps)',
  open: async (m) => {
    recordBaseline(m);
    await typeKeys(m, '/mode');
    await m.until(() => m.frame().join('\n').includes('Choose the startup default for new chats.'));
    await m.settle();
  },
};

export const MODE_HOME_SURFACES: readonly HomeSurface[] = [
  MODE_LIST_SURFACE,
  modeSurface(
    {
      id: 'home.mode-confirm',
      title:
        'The /mode popup on the bare Home: the confirmation (what is written, to which file), the Ctrl+Y chord step',
      landmark: 'Save plan as your startup default?',
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
